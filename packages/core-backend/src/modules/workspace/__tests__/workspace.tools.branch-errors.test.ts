import type { Server as HttpServer } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import '@utcp/http'; // registers the http CallTemplate serializer + protocol
import { UtcpManualSerializer } from '@utcp/sdk';
import { HttpCallTemplateSerializer } from '@utcp/http';
import { CodeModeUtcpClient } from '../../code-mode/index.js';
import { testKbContext } from '../../../__tests__/kb-context.js';
import { NodeFs } from '../../kb-fs/node-fs.js';
import { ToolRegistry } from '../../tool-registry/tool-registry.js';
import { createToolHandlerFactory } from '../../tool-helpers/tool-handler.js';
import { createToolContextResolver } from '../../tool-helpers/tool-context.js';
import type { ToolAuth } from '../../tool-auth/tool-auth.middleware.js';
import type { AuthService } from '../../auth/auth.service.js';
import type { IAccessControl } from '../../access/access-control.interface.js';
import type { ICreatorAccess } from '../../access-model/creator.js';
import type { WorkflowEventBus } from '../../workflow/event-bus.js';
import { WorkflowHooks } from '../../workflow/workflow-hooks.js';
import { ToolDescriptionNotes } from '../../workspace/agent-access.gate.js';
import { RoutineWritePolicyService } from '../routine-write-policy.js';
import { SpillStore } from '../spill-store.js';
import { DocExtractService } from '../file-readers/doc-extract.service.js';
import { registerWorkspaceTools } from '../workspace.tools.js';
import { WorkspaceService } from '../workspace.service.js';

const execFileAsync = promisify(execFile);
const KB_DIR = 'knowledge-base';

const allowAll = {
  canRead: async () => true,
  canReadBatch: async (_w: string, _u: string, paths: string[]) =>
    new Map(paths.map((p) => [p, true])),
} as unknown as IAccessControl;

const stubCreatorAccess: ICreatorAccess = {
  planForCreate: async () => null,
  grantInExtractedFile: async () => null,
  noteAccessFileWritten: () => {},
};

async function runGit(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@x.com',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@x.com',
    },
  });
}

/**
 * The agent surface reaches a branch the same way the browser does — a tool
 * names it, `getFilesystem` resolves the per-branch clone — so the same two
 * refusals must come back out of a tool call, with the discriminator a model
 * (or the MCP proxy) can branch on rather than prose it has to read. This is
 * the surface the bug was reported from: a tester named a branch nobody ever
 * created and was told it "no longer exists on the remote".
 */
describe('workspace tools — a branch that cannot be opened', () => {
  let httpServer: HttpServer | undefined;
  let root = '';
  let workspaces: WorkspaceService | null = null;
  let spillRoot = '';
  let docCacheDir = '';

  afterEach(async () => {
    if (httpServer) {
      // Drop the pooled keep-alive sockets first, or close() waits out the
      // 5s keepAliveTimeout on every test in this file.
      httpServer.closeAllConnections();
      await new Promise<void>((r) => httpServer!.close(() => r()));
    }
    httpServer = undefined;
    workspaces = null;
    for (const dir of [root, spillRoot, docCacheDir]) {
      if (dir) await rm(dir, { recursive: true, force: true });
    }
    root = '';
    spillRoot = '';
    docCacheDir = '';
  });

  /**
   * A real per-branch WorkspaceService over a real local origin, behind the
   * real tool-context resolver — so a tool call clones (or fails to clone)
   * exactly as it does in production.
   */
  /** The tool defs the mounted registry serves, kept for the sweep below. */
  let internalTools: { name: string; inputs: unknown }[] = [];

  async function start(
    opts: { repoUrl?: 'origin' | 'unreachable'; scope?: 'read' | 'write'; source?: 'internal' | 'external' } = {},
  ): Promise<string> {
    root = await mkdtemp(join(tmpdir(), 'ws-tools-branch-'));
    spillRoot = await mkdtemp(join(tmpdir(), 'ws-tools-spill-'));
    docCacheDir = await mkdtemp(join(tmpdir(), 'ws-tools-doc-'));
    const workspacesRoot = join(root, 'workspaces');
    await mkdir(workspacesRoot, { recursive: true });

    const upstream = join(root, 'upstream.git');
    await runGit(root, ['init', '--bare', '-b', 'target-company-state', upstream]);
    const seed = join(root, '.seed');
    await mkdir(seed);
    await runGit(seed, ['init', '-b', 'target-company-state']);
    await runGit(seed, ['remote', 'add', 'origin', upstream]);
    await mkdir(join(seed, KB_DIR));
    await writeFile(join(seed, KB_DIR, 'a.md'), 'hello\n', 'utf-8');
    await runGit(seed, ['add', '.']);
    await runGit(seed, ['commit', '-m', 'init']);
    await runGit(seed, ['checkout', '-b', 'alice/draft']);
    await runGit(seed, ['commit', '--allow-empty', '-m', 'draft']);
    await runGit(seed, ['push', 'origin', 'target-company-state', 'alice/draft']);

    workspaces = new WorkspaceService(
      workspacesRoot,
      opts.repoUrl === 'unreachable' ? join(root, 'no-such-repo.git') : upstream,
      testKbContext({ kbDirName: KB_DIR }),
      new NodeFs(),
    );

    const resolve = createToolContextResolver({
      authService: {
        getUserById: async () => ({ id: 'u', email: 'alice@example.com', name: 'Alice' }),
      } as unknown as AuthService,
      workspaceService: workspaces,
      workflowService: {} as never,
      events: { emit: () => {} } as unknown as WorkflowEventBus,
      kbDirName: KB_DIR,
      creatorAccess: stubCreatorAccess,
    });

    const app = express();
    app.use(express.json());
    const router = express.Router();
    const registry = new ToolRegistry();
    // The internal discovery endpoint, exactly as `manual.routes` serves it —
    // what a real `CodeModeUtcpClient` reads to learn the tools it can call
    // from inside a chain. Served here so the chain test below drives the SAME
    // routes as every direct call in this file.
    router.get('/agent/internal/utcp', async (_req, res) => {
      res.json(
        new UtcpManualSerializer().validateDict({
          utcp_version: '1.1.0',
          manual_version: '1.0.0',
          tools: await registry.listInternal(),
        }),
      );
    });
    registerWorkspaceTools(
      registry,
      router,
      (req: express.Request, _res: express.Response, next: express.NextFunction) => {
        req.toolAuth = {
          // The sweep below asks for `internal` + `write`, which is what reaches
          // the internal-only tools and gets past the write-scope refusal that
          // sits in FRONT of every handler. Everything else in this file stays
          // on the external read surface the bug was reported from.
          source: opts.source ?? 'external',
          userId: 'u',
          scope: opts.scope ?? 'read',
        } as ToolAuth;
        next();
      },
      createToolHandlerFactory(resolve),
      new SpillStore(spillRoot),
      new DocExtractService(docCacheDir),
      allowAll,
      testKbContext({ kbDirName: KB_DIR }),
      {
        recoveryBotEmail: 'recovery-bot@bevel.local',
        hooks: new WorkflowHooks(),
        notes: new ToolDescriptionNotes(),
      },
      new RoutineWritePolicyService(),
      {} as never,
    );
    app.use('/api', router);
    internalTools = (await registry.listInternal()) as unknown as { name: string; inputs: unknown }[];
    httpServer = await new Promise<HttpServer>((r) => {
      const s = app.listen(0, () => r(s));
    });
    return `http://127.0.0.1:${(httpServer.address() as { port: number }).port}`;
  }

  /** Call a tool with an arbitrary body — including one that omits `branch`. */
  const callTool = async (
    base: string,
    tool: string,
    body: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = await fetch(`${base}/api/agent/tools/${tool}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer x' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  const listFiles = async (base: string, branch: string): Promise<{ status: number; body: Record<string, unknown> }> =>
    callTool(base, 'list_files', { branch, path: '' });

  /** Every entry currently under the workspaces root. */
  const workspaceDirs = async (): Promise<string[]> =>
    (await readdir(join(root, 'workspaces'))).sort();

  const deleteOnHost = (branch: string): Promise<void> =>
    runGit(join(root, 'upstream.git'), ['branch', '-D', branch]);

  it('404s a branch nothing has ever cloned or listed, and says only that', async () => {
    const base = await start();

    const { status, body } = await listFiles(base, 'nobody/never-made-this');

    expect(status).toBe(404);
    expect(body).toEqual({
      kind: 'branch-not-found',
      branch: 'nobody/never-made-this',
      error: 'There is no branch named nobody/never-made-this.',
    });
  });

  /**
   * The reported bug, from the outside: every tool call made without a
   * `branch` answered `Branch "undefined" no longer exists on the remote.` —
   * the missing input was carried all the way down, turned into a workspace
   * directory named `undefined`, and the failed clone of that "branch" was
   * then explained as a branch that had been deleted.
   *
   * The input is refused BY NAME instead, at the boundary, before any of that
   * can happen. `list_files` stands in for every knowledge-base tool here
   * because they share the one choke point (`getFilesystem`) — the refusal is
   * the context resolver's, not this tool's.
   */
  describe('a call that names no branch', () => {
    // Every shape of "the caller sent no branch". The literals are in here
    // because a client that interpolates a variable it never set sends the
    // STRING "undefined" — indistinguishable, in intent, from omitting it, and
    // the one value that must never reach a clone.
    const absent: Array<[label: string, body: Record<string, unknown>]> = [
      ['the field is missing entirely', { path: '' }],
      ['the field is empty', { branch: '', path: '' }],
      ['the field is null', { branch: null, path: '' }],
      ['the field is a number', { branch: 42, path: '' }],
      ['the field is an object', { branch: { name: 'main' }, path: '' }],
      ['the field is an array', { branch: ['main'], path: '' }],
      ['the field is the literal "undefined"', { branch: 'undefined', path: '' }],
      ['the field is the literal "null"', { branch: 'null', path: '' }],
    ];

    for (const [label, body] of absent) {
      it(`400s branch-required when ${label}`, async () => {
        const base = await start();

        const res = await callTool(base, 'list_files', body);

        expect(res.status).toBe(400);
        expect(res.body).toEqual({
          kind: 'branch-required',
          error: '`branch` is required: pass the branch (draft) you are working on.',
        });
        // The refusal is the whole story: nothing was created and nothing was
        // cloned. An empty workspaces root is the strongest form of that
        // claim — there is no directory named for any branch, least of all one
        // named `undefined`.
        expect(await workspaceDirs()).toEqual([]);
      });
    }

    it('never writes `undefined` or `null` as a branch name into the answer', async () => {
      const base = await start();

      const res = await callTool(base, 'list_files', { path: '' });

      // AC3, checked against the whole response rather than one field: the
      // message names the INPUT and what to pass, never a stringified value of
      // what was missing. `Branch "undefined" no longer exists` is exactly the
      // sentence this must never produce again.
      const serialized = JSON.stringify(res.body);
      expect(serialized).not.toContain('undefined');
      expect(serialized).not.toContain('null');
    });

    /**
     * `call_tool_chain` is the other way every one of these tools gets called,
     * and it is where the bug was reported from just as often. It is not a
     * second implementation to guard: the chain's UTCP http transport POSTs to
     * the SAME `/agent/tools/...` route this file has been calling directly, so
     * the one refusal covers both. This test is what proves that claim rather
     * than assuming it — with a real `CodeModeUtcpClient` reading a real
     * manual and running real JavaScript.
     */
    it('400s branch-required from inside call_tool_chain, and creates no workspace', async () => {
      const base = await start();
      const client = await CodeModeUtcpClient.create(process.cwd(), {
        variables: { bevel_API_URL: base, bevel_CONNECTION_KEY: 'internal-token' },
      } as never);
      await client.registerManual(
        new HttpCallTemplateSerializer().validateDict({
          name: 'bevel',
          call_template_type: 'http',
          http_method: 'GET',
          url: '${API_URL}/api/agent/internal/utcp',
          content_type: 'application/json',
          headers: { Authorization: 'Bearer ${CONNECTION_KEY}' },
        }),
      );

      // The exact call from the specification: a chain that names the path and
      // forgets the branch. The tool THROWS inside the chain, so the failure is
      // caught and its message returned — the runtime's own contract for
      // surfacing a tool error to the model.
      const { result } = await client.callToolChain(
        `try { return { ok: bevel.list_files({ body: { path: 'knowledge-base' } }) }; }
         catch (err) { return { failed: err.message }; }`,
        30_000,
      );

      // The tool did not run.
      expect(result.ok).toBeUndefined();
      // The message the chain hands the model carries the whole refusal: the
      // status, the sentence, and the `kind` the direct caller switches on.
      // (The status and payload are IN the message rather than on the thrown
      // object — the sandboxed error exposes no own properties — which is why
      // this asserts on the text the model actually reads.)
      expect(result.failed).toContain('HTTP 400');
      expect(result.failed).toContain('`branch` is required: pass the branch (draft) you are working on.');
      expect(result.failed).toContain('"kind":"branch-required"');
      // Not the sentence the bug produced — and no invented branch name in it.
      expect(result.failed).not.toContain('no longer exists');
      expect(result.failed).not.toContain('undefined');
      // And the chain path refuses just as early: nothing was cloned.
      expect(await workspaceDirs()).toEqual([]);
    });

    /**
     * AC1 says "any knowledge-base tool", so this asserts it of EVERY tool the
     * module mounts rather than of the one this file otherwise drives. The list
     * comes from the registry, so a tool added later is swept in automatically
     * and cannot quietly reintroduce the bug on its own route. The guard runs
     * ahead of every other check, which is what lets one empty body stand in
     * for a valid call to each of them.
     */
    it('400s branch-required on every mounted tool that declares `branch`', async () => {
      const base = await start({ source: 'internal', scope: 'write' });
      const declaresBranch = internalTools
        .filter((t) => {
          const body = (t.inputs as { properties?: { body?: { required?: string[] } } }).properties?.body;
          return (body?.required ?? []).includes('branch');
        })
        .map((t) => t.name);

      // The whole branch-taking surface, not a sample of it.
      expect(declaresBranch.length).toBeGreaterThan(10);

      for (const tool of declaresBranch) {
        const res = await callTool(base, tool, {});
        expect(res.status, `${tool} must 400 on a branch-less call`).toBe(400);
        expect(res.body.kind, `${tool} must answer kind branch-required`).toBe('branch-required');
        // No tool's refusal may name the value it did not get.
        expect(JSON.stringify(res.body), `${tool} must not echo an absent value`).not.toContain('undefined');
      }
      expect(await workspaceDirs()).toEqual([]);
    });

    it('still serves the same tool once a branch is named', async () => {
      const base = await start();
      // The guard refuses an absent input, not the tool: the same call with a
      // real branch works, so the refusal cannot be a tool that simply broke.
      expect((await callTool(base, 'list_files', { path: '' })).status).toBe(400);

      const { status, body } = await listFiles(base, 'alice/draft');

      expect(status).toBe(200);
      expect((body.entries as { name: string }[]).map((e) => e.name)).toContain(KB_DIR);
    });
  });

  /**
   * The second half of the bug: a bootstrap that failed to clone used to leave
   * a directory behind, and a directory named after a branch is how the
   * platform remembers having known one. The first attempt's leftovers turned
   * the second attempt's honest "no such branch" into "it was deleted".
   */
  it('answers 404 again on a second attempt at a name that never existed', async () => {
    const base = await start();

    const first = await listFiles(base, 'nobody/never-made-this');
    expect(first.status).toBe(404);
    // Nothing survived the failed clone — not the repo directory, not the
    // workspace shell around it. This is what keeps the next attempt honest.
    expect(await workspaceDirs()).toEqual([]);

    const second = await listFiles(base, 'nobody/never-made-this');

    expect(second.status).toBe(404);
    expect(second.body).toEqual({
      kind: 'branch-not-found',
      branch: 'nobody/never-made-this',
      error: 'There is no branch named nobody/never-made-this.',
    });
    expect(await workspaceDirs()).toEqual([]);
  });

  it('410s a branch a listing showed us and origin no longer has', async () => {
    const base = await start();
    workspaces!.noteBranchesListed(['target-company-state', 'alice/draft']);
    await deleteOnHost('alice/draft');

    const { status, body } = await listFiles(base, 'alice/draft');

    expect(status).toBe(410);
    expect(body).toMatchObject({ kind: 'remote-branch-gone', branch: 'alice/draft' });
  });

  it('serves a branch that exists', async () => {
    const base = await start();

    const { status, body } = await listFiles(base, 'alice/draft');

    expect(status).toBe(200);
    expect((body.entries as { name: string }[]).map((e) => e.name)).toContain(KB_DIR);
  });

  it('500s an unreachable remote rather than blaming the branch', async () => {
    const base = await start({ repoUrl: 'unreachable' });

    const { status, body } = await listFiles(base, 'alice/draft');

    expect(status).toBe(500);
    expect(body.kind).toBeUndefined();
  });
});
