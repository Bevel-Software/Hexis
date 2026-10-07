import type { Server as HttpServer } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { testKbContext, TEST_BRANCH_MODEL } from '../../../__tests__/kb-context.js';
import { NodeFs } from '../../kb-fs/node-fs.js';
import { WorkspaceService } from '../../workspace/workspace.service.js';
import type { AuthService } from '../../auth/auth.service.js';
import type { ICreatorAccess } from '../../access-model/creator.js';
import type { WorkflowEventBus } from '../../workflow/event-bus.js';
import type { ToolAuth } from '../../tool-auth/tool-auth.middleware.js';
import type { KbContext } from '../../../shared/kb-context.js';
import { BRANCH_REQUIRED_MESSAGE } from '../../../shared/domain-errors.js';
import { workspaceIdForBranch } from '../../../shared/workspace-id.js';
import { createToolContextResolver } from '../tool-context.js';
import { createToolHandlerFactory } from '../tool-handler.js';
import {
  BRANCH_INPUT,
  toolDef,
  type BranchDeclaration,
  type ToolDefSpec,
} from '../index.js';

const execFileAsync = promisify(execFile);
const KB_DIR = 'knowledge-base';
const DEFAULT_BRANCH = TEST_BRANCH_MODEL.defaultBranch;

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

/** What one run of a test tool was handed. */
interface Received {
  tool: string;
  hasBranchArg: boolean;
  argBranch: unknown;
  ctxBranch: unknown;
}

/**
 * The branch declaration, end to end, as a DEPLOYMENT uses it: test tools
 * built with the public `toolDef` and mounted with the `toolHandler` the
 * overlay hook hands out, carrying no branch code of their own — behind the
 * real context resolver, over a real `WorkspaceService` cloning a real local
 * origin. The scenarios are the Specification's.
 */
describe('a tool declares how it treats its branch', () => {
  let httpServer: HttpServer | undefined;
  let root = '';
  let kb: KbContext;
  let received: Received[] = [];
  /** The deployment's default branch is unconfigured while this is set. */
  let defaultBranchUnset = false;

  afterEach(async () => {
    // Read before the cleanup, asserted after it: a failed assertion must not
    // leave the server listening or the temporary repository behind.
    const dirs = root ? await readdir(join(root, 'workspaces')) : [];
    if (httpServer) {
      httpServer.closeAllConnections();
      await new Promise<void>((r) => httpServer!.close(() => r()));
    }
    httpServer = undefined;
    received = [];
    defaultBranchUnset = false;
    if (root) await rm(root, { recursive: true, force: true });
    root = '';
    // Whatever the scenario, no call ever leaves a workspace named after a
    // missing branch behind.
    expect(dirs).not.toContain('undefined');
    expect(dirs).not.toContain(workspaceIdForBranch('undefined'));
    expect(dirs).not.toContain('null');
  });

  /** A deployment's tool: built with `toolDef`, nothing about the branch in its handler. */
  function testTool(name: string, extra: Partial<ToolDefSpec> = {}): ToolDefSpec {
    return {
      name,
      description: `Test tool ${name}.`,
      path: `/api/agent/tools/${name}`,
      inputs: { type: 'object', properties: { note: { type: 'string' } }, additionalProperties: false },
      ...extra,
    };
  }

  async function start(): Promise<string> {
    root = await mkdtemp(join(tmpdir(), 'branch-decl-'));
    const workspacesRoot = join(root, 'workspaces');
    await mkdir(workspacesRoot, { recursive: true });
    const upstream = join(root, 'upstream.git');
    await runGit(root, ['init', '--bare', '-b', DEFAULT_BRANCH, upstream]);
    const seed = join(root, '.seed');
    await mkdir(seed);
    await runGit(seed, ['init', '-b', DEFAULT_BRANCH]);
    await runGit(seed, ['remote', 'add', 'origin', upstream]);
    // The repository root IS the clone's `knowledge-base` folder.
    await writeFile(join(seed, 'a.md'), 'hello\n', 'utf-8');
    await runGit(seed, ['add', '.']);
    await runGit(seed, ['commit', '-m', 'init']);
    await runGit(seed, ['checkout', '-b', 'my-draft']);
    await runGit(seed, ['commit', '--allow-empty', '-m', 'draft']);
    await runGit(seed, ['push', 'origin', DEFAULT_BRANCH, 'my-draft']);
    // A branch whose name ENDS in `refs/heads/ghost`: `ls-remote`'s pattern
    // matches it for `ghost`, which does not exist.
    await runGit(seed, ['push', 'origin', 'HEAD:refs/heads/refs/heads/ghost']);

    kb = testKbContext({ kbDirName: KB_DIR });
    const workspaces = new WorkspaceService(workspacesRoot, upstream, kb, new NodeFs());
    const resolve = createToolContextResolver({
      authService: {
        getUserById: async () => ({ id: 'u', email: 'alice@example.com', name: 'Alice' }),
      } as unknown as AuthService,
      workspaceService: workspaces,
      workflowService: {} as never,
      events: { emit: () => {} } as unknown as WorkflowEventBus,
      kbDirName: KB_DIR,
      creatorAccess: {} as ICreatorAccess,
    });
    // Wired exactly as the composition root wires it.
    const toolHandler = createToolHandlerFactory(resolve, undefined, {
      defaultBranch: () => (defaultBranchUnset ? '' : kb.defaultBranch),
      // `storage-fault` stands for a workspaces root the probe cannot read.
      isMissing: (branch) =>
        branch === 'storage-fault'
          ? Promise.reject(
              Object.assign(new Error(`EACCES: permission denied, access '${workspacesRoot}/x'`), { code: 'EACCES' }),
            )
          : workspaces.isBranchMissing(branch),
    });

    const router = express.Router();
    // Read scope, as a read-only tool's caller has; only a route mounted as
    // writing is called with write scope.
    const toolAuth =
      (scope: 'read' | 'write') =>
      (req: express.Request, _res: express.Response, next: express.NextFunction): void => {
        req.toolAuth = { source: 'external', userId: 'u', scope } as ToolAuth;
        next();
      };
    const mount = (
      spec: ToolDefSpec,
      answer: (branch: unknown) => unknown = () => ({ ok: true }),
      opts: { write?: boolean } = {},
    ): void => {
      toolDef(spec);
      router.post(
        spec.path.slice('/api'.length),
        toolAuth(opts.write ? 'write' : 'read'),
        toolHandler(async (args, ctx) => {
          received.push({
            tool: spec.name,
            hasBranchArg: 'branch' in args,
            argBranch: args.branch,
            ctxBranch: ctx.branch,
          });
          // A tool that takes a branch opens it, as a real one would.
          if (typeof ctx.branch === 'string') {
            const fs = await ctx.getFilesystem(ctx.branch);
            return answer((await fs.readFile(`${KB_DIR}/a.md`, { encoding: 'utf-8' })).toString().trim());
          }
          return answer(undefined);
        }, opts),
      );
    };
    // The three declarations, plus a `required` read off the inputs alone —
    // what every deployment tool that declared `branch: BRANCH_INPUT` before
    // this change is.
    mount(testTool('t_default', { branch: 'defaults-to-default-branch' }), (content) => ({ content }));
    mount(testTool('t_required', { branch: 'required' }));
    mount(
      testTool('t_required_by_schema', {
        inputs: { type: 'object', properties: { branch: BRANCH_INPUT }, required: ['branch'] },
      }),
    );
    mount(testTool('t_none'));
    mount(testTool('t_default_own_branch', { branch: 'defaults-to-default-branch' }), () => ({ branch: 'its-own' }));
    mount(testTool('t_default_array', { branch: 'defaults-to-default-branch' }), () => ['a', 'b']);
    mount(testTool('t_default_date', { branch: 'defaults-to-default-branch' }), () => new Date(0));
    mount(
      testTool('t_default_undefined_branch', { branch: 'defaults-to-default-branch' }),
      (content) => ({ content, branch: undefined }),
    );
    // Declared defaulting to a `toolDef` that was not told it writes, and
    // mounted as writing: the handler holds it to `required`.
    mount(testTool('t_default_mounted_write', { branch: 'defaults-to-default-branch' }), undefined, { write: true });

    const app = express();
    app.use(express.json());
    app.use('/api', router);
    httpServer = await new Promise<HttpServer>((r) => {
      const s = app.listen(0, () => r(s));
    });
    return `http://127.0.0.1:${(httpServer.address() as { port: number }).port}`;
  }

  const call = async (
    base: string,
    tool: string,
    body: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = await fetch(`${base}/api/agent/tools/${tool}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  const workspaceDirs = async (): Promise<string[]> => (await readdir(join(root, 'workspaces'))).sort();

  describe('defaults-to-default-branch', () => {
    it('runs a call without a branch on the default branch, and says so in the answer', async () => {
      const base = await start();

      const res = await call(base, 't_default', {});

      expect(res.status).toBe(200);
      expect(received).toEqual([
        { tool: 't_default', hasBranchArg: true, argBranch: DEFAULT_BRANCH, ctxBranch: DEFAULT_BRANCH },
      ]);
      expect(res.body).toEqual({ content: 'hello', branch: DEFAULT_BRANCH });
    });

    it('runs on the branch the call names, and adds no `branch` field', async () => {
      const base = await start();

      const res = await call(base, 't_default', { branch: 'my-draft' });

      expect(res.status).toBe(200);
      expect(received).toEqual([
        { tool: 't_default', hasBranchArg: true, argBranch: 'my-draft', ctxBranch: 'my-draft' },
      ]);
      expect(res.body).toEqual({ content: 'hello' });
    });

    it('refuses an empty branch by name rather than defaulting it, and the tool does not run', async () => {
      const base = await start();

      const res = await call(base, 't_default', { branch: '' });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ kind: 'branch-required', error: BRANCH_REQUIRED_MESSAGE });
      expect(res.body.error).toContain('`branch`');
      expect(received).toEqual([]);
    });

    it('answers 404 naming a branch that does not exist, runs nothing and creates no workspace', async () => {
      const base = await start();

      const res = await call(base, 't_default', { branch: 'no-such-branch' });

      expect(res.status).toBe(404);
      expect(res.body).toEqual({
        kind: 'branch-not-found',
        branch: 'no-such-branch',
        error: 'There is no branch named no-such-branch.',
      });
      expect(received).toEqual([]);
      expect(await workspaceDirs()).toEqual([]);
    });

    it('answers a storage fault while checking the branch as a 500 that carries no path, and runs nothing', async () => {
      const base = await start();

      const res = await call(base, 't_default', { branch: 'storage-fault' });

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Could not check whether branch storage-fault exists.' });
      expect(JSON.stringify(res.body)).not.toContain(root);
      expect(received).toEqual([]);
    });

    it('follows a default branch renamed in the settings on the next call', async () => {
      const base = await start();
      expect((await call(base, 't_default', {})).body.branch).toBe(DEFAULT_BRANCH);

      kb.applyBranchModel({ defaultBranch: 'my-draft', protectedBranches: ['my-draft'] });
      const res = await call(base, 't_default', {});

      expect(res.status).toBe(200);
      expect(res.body.branch).toBe('my-draft');
      expect(received.map((r) => r.ctxBranch)).toEqual([DEFAULT_BRANCH, 'my-draft']);
    });

    it('leaves an answer that already has a `branch`, or is not an object, as the tool gave it', async () => {
      const base = await start();

      expect((await call(base, 't_default_own_branch', {})).body).toEqual({ branch: 'its-own' });
      const arr = await fetch(`${base}/api/agent/tools/t_default_array`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(await arr.json()).toEqual(['a', 'b']);
      // A `Date` is not a plain object: it stays the ISO string it serializes to.
      const date = await fetch(`${base}/api/agent/tools/t_default_date`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(await date.json()).toBe(new Date(0).toISOString());
    });

    it('names the branch used when the answer carries an undefined `branch`', async () => {
      const base = await start();

      const res = await call(base, 't_default_undefined_branch', {});

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ content: 'hello', branch: DEFAULT_BRANCH });
    });

    it('answers a call without a branch on a deployment with no default branch as unconfigured, not as the caller\'s mistake', async () => {
      const base = await start();
      defaultBranchUnset = true;

      const res = await call(base, 't_default', {});

      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({ kind: 'default-branch-unset' });
      expect(received).toEqual([]);
      // Naming a branch still works.
      expect((await call(base, 't_default', { branch: 'my-draft' })).status).toBe(200);
    });

    it('shows `branch` as optional in the input schema, saying what happens without it', () => {
      const def = toolDef(testTool('t_schema_default', { branch: 'defaults-to-default-branch' }));
      const body = (def.inputs as { properties: { body: { properties: Record<string, { description: string }>; required?: string[] } } })
        .properties.body;

      expect(body.properties.branch).toBeDefined();
      expect(body.required ?? []).not.toContain('branch');
      expect(body.properties.branch.description).toMatch(/default branch/);
    });
  });

  describe('required', () => {
    for (const tool of ['t_required', 't_required_by_schema']) {
      it(`${tool}: refuses a call without a branch with the sentence read_file gives, though the tool has no code for it`, async () => {
        const base = await start();

        const res = await call(base, tool, {});

        expect(res.status).toBe(400);
        // `read_file`'s refusal is this constant: see workspace.tools.branch-errors.test.ts.
        expect(res.body).toEqual({ kind: 'branch-required', error: BRANCH_REQUIRED_MESSAGE });
        expect(received).toEqual([]);
      });

      it(`${tool}: answers 404 naming a branch that does not exist, before the tool runs`, async () => {
        const base = await start();

        const res = await call(base, tool, { branch: 'no-such-branch' });

        expect(res.status).toBe(404);
        expect(res.body).toMatchObject({ kind: 'branch-not-found', branch: 'no-such-branch' });
        expect(received).toEqual([]);
        expect(await workspaceDirs()).toEqual([]);
      });

      it(`${tool}: answers 404 for a branch only a longer ref name ends in`, async () => {
        const base = await start();

        const res = await call(base, tool, { branch: 'ghost' });

        expect(res.status).toBe(404);
        expect(res.body).toMatchObject({ kind: 'branch-not-found', branch: 'ghost' });
        expect(received).toEqual([]);
      });

      it(`${tool}: runs on the branch the call names`, async () => {
        const base = await start();

        const res = await call(base, tool, { branch: 'my-draft' });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true });
        expect(received).toEqual([{ tool, hasBranchArg: true, argBranch: 'my-draft', ctxBranch: 'my-draft' }]);
      });
    }

    it('keeps `branch` required in the input schema', () => {
      const def = toolDef(testTool('t_schema_required', { branch: 'required' }));
      const body = (def.inputs as { properties: { body: { properties: Record<string, unknown>; required: string[] } } })
        .properties.body;

      expect(body.properties.branch).toEqual(BRANCH_INPUT);
      expect(body.required).toContain('branch');
    });
  });

  /**
   * Requirement 7, for all three declarations: whatever a caller sends, a tool
   * that runs has a non-empty string as its branch (or, taking no branch, has
   * none at all) — never `undefined`, an empty string or another type.
   */
  describe('a tool never receives an unusable branch', () => {
    const bodies: Array<[label: string, body: Record<string, unknown>]> = [
      ['missing', {}],
      ['empty', { branch: '' }],
      ['null', { branch: null }],
      ['a number', { branch: 42 }],
      ['an object', { branch: { name: 'main' } }],
      ['an array', { branch: ['main'] }],
      ['the literal "undefined"', { branch: 'undefined' }],
      ['the literal "null"', { branch: 'null' }],
    ];
    const declarations: Array<[BranchDeclaration | 'none', string]> = [
      ['required', 't_required'],
      ['defaults-to-default-branch', 't_default'],
      ['none', 't_none'],
    ];

    for (const [declaration, tool] of declarations) {
      it(`under ${declaration}`, async () => {
        const base = await start();

        for (const [label, body] of bodies) {
          received = [];
          const res = await call(base, tool, body);
          if (received.length === 0) {
            expect(res.status, `${label}: refused`).toBe(400);
            continue;
          }
          const [got] = received;
          if (declaration === 'none') {
            expect(got.hasBranchArg, `${label}: no branch reaches a tool that takes none`).toBe(false);
            expect(got.ctxBranch).toBeUndefined();
          } else {
            expect(typeof got.argBranch, label).toBe('string');
            expect((got.argBranch as string).length, label).toBeGreaterThan(0);
            expect(got.ctxBranch, label).toBe(got.argBranch);
          }
        }
        if (declaration === 'defaults-to-default-branch') {
          // Only the missing branch was defaulted; every other value was refused.
          received = [];
          await call(base, tool, {});
          expect(received[0].ctxBranch).toBe(DEFAULT_BRANCH);
        }
      });
    }
  });

  describe('a writing tool', () => {
    it('cannot declare defaults-to-default-branch: registering it fails, naming the tool', () => {
      expect(() =>
        toolDef(testTool('deployment_write_tool', { branch: 'defaults-to-default-branch', write: true })),
      ).toThrow(/deployment_write_tool/);
      expect(() =>
        toolDef(testTool('deployment_tagged_write', { branch: 'defaults-to-default-branch', tags: ['write'] })),
      ).toThrow(/deployment_tagged_write/);
    });

    it('mounted as writing, is held to required even when declared defaulting', async () => {
      const base = await start();

      const res = await call(base, 't_default_mounted_write', {});

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ kind: 'branch-required', error: BRANCH_REQUIRED_MESSAGE });
      expect(received).toEqual([]);
      expect((await call(base, 't_default_mounted_write', { branch: 'my-draft' })).status).toBe(200);
    });

    it('may declare required', () => {
      expect(() => toolDef(testTool('deployment_write_ok', { branch: 'required', write: true }))).not.toThrow();
    });
  });
});
