import type { Server as HttpServer } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalFilesystem } from '@mastra/core/workspace';
import { ToolRegistry } from '../../tool-registry/tool-registry.js';
import { createToolHandlerFactory } from '../../tool-helpers/tool-handler.js';
import type { ToolContext } from '../../tool-helpers/tool.contract.js';
import type { ToolAuth } from '../../tool-auth/tool-auth.middleware.js';
import { registerWorkspaceTools } from '../workspace.tools.js';
import { RoutineWritePolicyService } from '../routine-write-policy.js';
import { WorkflowHooks } from '../../workflow/workflow-hooks.js';
import { SpillStore } from '../spill-store.js';
import type { IAccessControl } from '../../access/access-control.interface.js';
import { assertValidBranchName } from '../../workflow/git/branch-name.js';

const KB_DIR = 'knowledge-base';

/** Allow-all access control — the default for tests not exercising read gating. */
const allowAll = {
  canRead: async () => true,
  canReadBatch: async (_w: string, _u: string, paths: string[]) =>
    new Map(paths.map((p) => [p, true])),
} as unknown as IAccessControl;

/** Access control that denies `canRead` for an explicit set of repo-relative paths. */
function denyReads(denied: Set<string>): IAccessControl {
  return {
    canRead: async (_w: string, _u: string, rel: string) => !denied.has(rel),
    canReadBatch: async (_w: string, _u: string, paths: string[]) =>
      new Map(paths.map((p) => [p, !denied.has(p)])),
  } as unknown as IAccessControl;
}

/**
 * File primitives over a REAL LocalFilesystem on a temp dir — proves read_file /
 * write_file / edit_file / list_files / grep / file_stat / execute_command
 * actually work (the handlers re-expose the same filesystem methods Mastra
 * uses). No locking pipeline (plain LocalFilesystem), so writes don't commit.
 */

let httpServer: HttpServer | undefined;
let tempDir = '';
let fs: LocalFilesystem;
/**
 * Every branch / workspaceId `execute_command`'s handler resolves a workspace
 * for. Resolving a workspace is what triggers the lazy per-branch CLONE in
 * production, so asserting this never contains `"undefined"` proves the
 * missing-branch guard short-circuits before any clone of a branch literally
 * named "undefined" is attempted.
 */
let workspacePathCalls: string[] = [];
/** The policy instance the tools were mounted with, so a test can restrict a session. */
let writePolicy: RoutineWritePolicyService;
/**
 * The focused branch the resolved `ToolContext` carries — mirrors the branch an
 * internal token bakes for the in-process agent. A test sets it to prove a
 * branch-less `execute_command` falls back to the session's own workspace.
 */
let focusedBranch: string | undefined;

async function start(
  scope: 'read' | 'write' = 'write',
  access: IAccessControl = allowAll,
): Promise<string> {
  tempDir = await mkdtemp(join(tmpdir(), 'ws-tools-'));
  fs = new LocalFilesystem({ basePath: tempDir, contained: true });
  await fs.writeFile('a.md', 'hello\nworld\n');
  workspacePathCalls = [];
  writePolicy = new RoutineWritePolicyService();
  focusedBranch = undefined;

  const registry = new ToolRegistry();
  const resolve = async (auth: ToolAuth, signal: AbortSignal, sessionId?: string): Promise<ToolContext> => ({
    user: { id: 'u', email: 'e@x', name: 'N' },
    scope: auth.scope,
    source: auth.source,
    sessionId,
    focusedBranch,
    abortSignal: signal,
    workspaceService: {
      // Both entry points record, so the guard tests prove NEITHER resolves a
      // workspace for an invalid branch.
      getOrCreateForBranch: async (branch: string) => {
        workspacePathCalls.push(branch);
        return { id: encodeURIComponent(branch), name: branch, absolutePath: tempDir, createdAt: '', kbDirName: KB_DIR };
      },
      getWorkspacePath: async (id: string) => {
        workspacePathCalls.push(id);
        return tempDir;
      },
    } as never,
    workflowService: {} as never,
    events: {} as never,
    getFilesystem: async () => fs,
  });
  const toolHandler = createToolHandlerFactory(resolve);
  const fakeAuth = (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.toolAuth = { source: 'internal', userId: 'u', scope };
    next();
  };
  const app = express();
  app.use(express.json());
  const router = express.Router();
  registerWorkspaceTools(registry, router, fakeAuth, toolHandler, new SpillStore(join(tmpdir(), 'bevel-test-spills')), access, KB_DIR, {
    service: {} as never,
    enabled: false, // these tests predate and don't exercise the ontology boundary
    kbDirName: KB_DIR,
    recoveryBotEmail: 'recovery-bot@bevel.local',
    hooks: new WorkflowHooks(),
  }, writePolicy, {} as never /* sessionSink — start_session not exercised here */);
  app.use('/api', router);
  httpServer = await new Promise<HttpServer>((r) => {
    const s = app.listen(0, () => r(s));
  });
  return `http://127.0.0.1:${(httpServer.address() as { port: number }).port}`;
}

const post = (url: string, body: unknown = {}) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer x' }, body: JSON.stringify(body) });

beforeEach(() => {
  /* fresh per test via start() */
});
afterEach(async () => {
  if (httpServer) await new Promise<void>((r) => httpServer!.close(() => r()));
  httpServer = undefined;
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = '';
  }
});

describe('workspace file primitives', () => {
  it('read_file returns the content', async () => {
    const base = await start();
    expect(await (await post(`${base}/api/agent/tools/read_file`, { path: 'a.md' })).json()).toEqual({ path: 'a.md', content: 'hello\nworld\n' });
  });

  it('write_file then read_file round-trips', async () => {
    const base = await start();
    await post(`${base}/api/agent/tools/write_file`, { path: 'b.md', content: 'fresh' });
    expect(await (await post(`${base}/api/agent/tools/read_file`, { path: 'b.md' })).json()).toMatchObject({ content: 'fresh' });
  });

  it('edit_file replaces an exact unique string', async () => {
    const base = await start();
    const res = await post(`${base}/api/agent/tools/edit_file`, { path: 'a.md', old_string: 'world', new_string: 'earth' });
    expect(await res.json()).toMatchObject({ path: 'a.md', replaced: 1 });
    expect(await (await post(`${base}/api/agent/tools/read_file`, { path: 'a.md' })).json()).toMatchObject({ content: 'hello\nearth\n' });
  });

  it('edit_file 400s when old_string is missing', async () => {
    const base = await start();
    expect((await post(`${base}/api/agent/tools/edit_file`, { path: 'a.md', old_string: 'nope', new_string: 'x' })).status).toBe(400);
  });

  it('list_files + file_stat', async () => {
    const base = await start();
    const list = (await (await post(`${base}/api/agent/tools/list_files`, {})).json()) as { entries: { name: string }[] };
    expect(list.entries.map((e) => e.name)).toContain('a.md');
    expect(await (await post(`${base}/api/agent/tools/file_stat`, { path: 'a.md' })).json()).toMatchObject({ type: 'file' });
  });

  it('grep finds a match with line number', async () => {
    const base = await start();
    const res = (await (await post(`${base}/api/agent/tools/grep`, { pattern: 'wor' })).json()) as { matches: { path: string; line: number }[] };
    expect(res.matches).toContainEqual(expect.objectContaining({ path: 'a.md', line: 2 }));
  });

  it('execute_command runs in the workspace dir', async () => {
    const base = await start();
    const res = (await (await post(`${base}/api/agent/tools/execute_command`, { branch: 'main', command: 'echo hello-exec' })).json()) as { stdout: string; exitCode: number };
    expect(res.stdout).toContain('hello-exec');
    expect(res.exitCode).toBe(0);
  });

  it('execute_command 400s when no branch is given AND no focused branch (external caller)', async () => {
    const base = await start();
    // No `branch` arg and no `ctx.focusedBranch` (an external caller carries no
    // focused branch): the branch context is genuinely absent, so it must NOT
    // resolve the workspace id to "undefined" and try to clone a branch literally
    // named "undefined" — it fails closed with a clear 4xx naming the missing
    // branch context, BEFORE any workspace resolve.
    expect(focusedBranch).toBeUndefined();
    const res = await post(`${base}/api/agent/tools/execute_command`, { command: 'echo should-not-run' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/branch/i);
    // The guard runs before `getOrCreateForBranch`, so no workspace (least of all
    // the "undefined" one) is ever resolved — proving no clone is attempted.
    expect(workspacePathCalls).toEqual([]);
  });

  it('execute_command falls back to the session focused branch when branch is omitted', async () => {
    const base = await start();
    // The in-app chat agent, focused on `main`, may leave `branch` off a call.
    // For an internal session that carries a focused branch, the shell runs
    // against that branch's workspace and returns output end to end (AC2) —
    // rather than failing closed the way a context-less external call does.
    focusedBranch = 'main';
    const res = (await (await post(`${base}/api/agent/tools/execute_command`, { command: 'echo hello-exec' })).json()) as { stdout: string; exitCode: number };
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('hello-exec');
    // Resolved against the focused branch — never an "undefined" workspace.
    expect(workspacePathCalls).toEqual(['main']);
  });

  it('execute_command does NOT fall back to the focused branch for an invalid value', async () => {
    const base = await start();
    // A present-but-broken branch ("undefined") must fail closed even when a
    // focused branch is available — a broken value is never silently reinterpreted
    // as the session's branch.
    focusedBranch = 'main';
    const res = await post(`${base}/api/agent/tools/execute_command`, { branch: 'undefined', command: 'echo should-not-run' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/branch/i);
    expect(workspacePathCalls).toEqual([]);
  });

  // Every branch value that must fail closed without resolving a workspace.
  // `''` (like the missing field above) is refused a layer earlier by the input
  // schema's `minLength: 1`; the rest satisfy the schema and reach the handler,
  // so they exercise the guard itself. Both layers must produce the same 400.
  // The malformed refs below are rejected by the shared `assertValidBranchName`
  // shape check; the literal "undefined"/"null" — which that validator ACCEPTS
  // as ordinary git refs — are rejected by an explicit by-name check ahead of it
  // (AC3 requires them to fail closed; see the dedicated test below).
  const invalidBranches: Array<[label: string, branch: string]> = [
    ['empty', ''],
    ['whitespace-only', '   '],
    // Malformed refs — caught by the canonical `assertValidBranchName` shape
    // check, not by any hand-maintained list of literals.
    ['whitespace-padded (never silently trimmed)', ' main '],
    ['containing a space', 'alice/my draft'],
    ['a ".." ref', 'foo..bar'],
    ['containing ".."', 'alice/../../etc'],
    ['a leading dash (git would read it as a flag)', '-x'],
    ['starting with "--" (flag injection)', '--upload-pack=touch'],
    ['containing "//"', 'alice//draft'],
    ['ending with "/"', 'alice/'],
    ['a segment starting with "."', 'alice/.hidden'],
    ['a segment ending with ".lock"', 'alice/draft.lock'],
    ['containing "@{"', 'alice/draft@{0}'],
    ['containing a shell metacharacter', 'alice/draft;rm -rf /'],
  ];
  for (const [label, branch] of invalidBranches) {
    it(`execute_command 400s when branch is ${label}`, async () => {
      const base = await start();
      const res = await post(`${base}/api/agent/tools/execute_command`, { branch, command: 'echo should-not-run' });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/branch/i);
      // No workspace is resolved for the bad value — proving no clone is attempted.
      expect(workspacePathCalls).toEqual([]);
    });
  }

  /**
   * The production regression this ticket bounced on: the guard's hand-written
   * `"undefined"`/`"null"` rejection was replaced by the canonical
   * `assertValidBranchName` alone. Both literals are *syntactically valid* git
   * branch names, so the validator accepts them — a branch-less call then reached
   * `getOrCreateForBranch("undefined")`, cloned a branch literally named
   * `undefined` into `/app/workspaces/undefined/`, and 500'd in production.
   *
   * AC3 requires these literals to fail closed. Pinning the validator's own
   * behaviour here is the point: it documents WHY the literal check cannot be
   * folded into the shape check, so the next person who "simplifies" the guard
   * down to `assertValidBranchName` gets a red test naming the reason rather than
   * a fresh production 500.
   */
  it('rejects "undefined"/"null" even though the canonical validator accepts them', async () => {
    for (const literal of ['undefined', 'null']) {
      expect(() => assertValidBranchName(literal), `${literal} is a valid git ref`).not.toThrow();
    }
    const base = await start();
    for (const literal of ['undefined', 'null']) {
      const res = await post(`${base}/api/agent/tools/execute_command`, { branch: literal, command: 'echo should-not-run' });
      expect(res.status, `branch "${literal}" must 400`).toBe(400);
      // The message names the literal, so the agent can see what it actually sent.
      expect((await res.json()).error).toContain(literal);
    }
    expect(workspacePathCalls).toEqual([]);
  });

  it('execute_command validates the branch BEFORE the write-policy gate', async () => {
    const base = await start();
    // A routine-restricted session is refused by `assertUnrestricted` with 403.
    // The branch guard must still run first, so a malformed call gets the 400
    // that names the bad context instead of a 403 masking it.
    writePolicy.restrictToExtensions('restricted-run', ['.html']);
    const res = await post(`${base}/api/agent/tools/execute_command`, {
      branch: 'alice/../../etc',
      command: 'echo should-not-run',
      sessionId: 'restricted-run',
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/branch/i);
    expect(workspacePathCalls).toEqual([]);
    // …and the restriction really is live for that session (so the 400 above is
    // the guard winning the race, not an inert policy).
    const gated = await post(`${base}/api/agent/tools/execute_command`, {
      branch: 'main',
      command: 'echo should-not-run',
      sessionId: 'restricted-run',
    });
    expect(gated.status).toBe(403);
  });

  it('execute_command bootstraps the workspace through getOrCreateForBranch', async () => {
    const base = await start();
    // Per-branch bootstrap is the service's job: the shell passes the branch
    // itself rather than hand-encoding a workspace id.
    await post(`${base}/api/agent/tools/execute_command`, { branch: 'alice/draft', command: 'echo hi' });
    expect(workspacePathCalls).toEqual(['alice/draft']);
  });

  it('execute_command runs plain git against the nested KB clone', async () => {
    const base = await start();
    // Production layout: the repo lives one level BELOW the shell's cwd, at
    // <workspace>/<kbDirName>/.git. A bare `git …` (what the agent prompt
    // teaches) must still target that clone instead of failing with
    // "not a git repository".
    const execFileAsync = promisify(execFile);
    const repoDir = join(tempDir, KB_DIR);
    await mkdir(repoDir, { recursive: true });
    await execFileAsync('git', ['init'], { cwd: repoDir });
    await execFileAsync(
      'git',
      ['-c', 'user.email=t@test', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'kb-seed'],
      { cwd: repoDir },
    );
    const res = (await (await post(`${base}/api/agent/tools/execute_command`, { branch: 'main', command: 'git log -1 --format=%s' })).json()) as { stdout: string; stderr: string; exitCode: number };
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe('kb-seed');
  });

  it('execute_command does not leak GIT_DIR into non-git commands', async () => {
    const base = await start();
    // The KB-clone GIT_DIR/GIT_WORK_TREE override is scoped to bare `git …`
    // only; a non-git command (e.g. npm/pip that shells git internally) must
    // NOT inherit it, or the nested git child would target the KB clone.
    const res = (await (await post(`${base}/api/agent/tools/execute_command`, { branch: 'main', command: 'echo "GIT_DIR=[$GIT_DIR]"' })).json()) as { stdout: string; stderr: string; exitCode: number };
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe('GIT_DIR=[]');
  });

  it('execute_command does not leak GIT_DIR into a chained step after git', async () => {
    const base = await start();
    // Runs under `shell: true`, so a command that merely STARTS with git but
    // chains another step must not export the KB git env to the whole shell —
    // otherwise `git … && npm ci` would leak the KB repo context into the npm/pip
    // git subprocess. `git --version` needs no repo, so exit stays 0.
    const res = (await (await post(`${base}/api/agent/tools/execute_command`, { branch: 'main', command: 'git --version >/dev/null && echo "leak=[$GIT_DIR]"' })).json()) as { stdout: string; stderr: string; exitCode: number };
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe('leak=[]');
  });

  it('read scope refuses write tools (403) but allows reads', async () => {
    const base = await start('read');
    expect((await post(`${base}/api/agent/tools/write_file`, { path: 'c.md', content: 'x' })).status).toBe(403);
    expect((await post(`${base}/api/agent/tools/read_file`, { path: 'a.md' })).status).toBe(200);
  });
});

describe('read-permission gating', () => {
  // Seed two KB nodes; the access stub denies read on the "secret" one.
  async function startGated(): Promise<string> {
    const base = await start('write', denyReads(new Set([`Knowledge/Secret.md`])));
    await fs.writeFile(`${KB_DIR}/Knowledge/Public.md`, 'public body\nneedle\n');
    await fs.writeFile(`${KB_DIR}/Knowledge/Secret.md`, 'secret body\nneedle\n');
    return base;
  }

  it('read_file denies an unreadable KB node with 403', async () => {
    const base = await startGated();
    expect((await post(`${base}/api/agent/tools/read_file`, { path: `${KB_DIR}/Knowledge/Secret.md` })).status).toBe(403);
    expect((await post(`${base}/api/agent/tools/read_file`, { path: `${KB_DIR}/Knowledge/Public.md` })).status).toBe(200);
  });

  it('list_files hides unreadable KB nodes but keeps readable ones', async () => {
    const base = await startGated();
    const list = (await (await post(`${base}/api/agent/tools/list_files`, { path: `${KB_DIR}/Knowledge` })).json()) as {
      entries: { name: string }[];
    };
    const names = list.entries.map((e) => e.name);
    expect(names).toContain('Public.md');
    expect(names).not.toContain('Secret.md');
  });

  it('grep never returns a line from an unreadable KB node', async () => {
    const base = await startGated();
    const res = (await (await post(`${base}/api/agent/tools/grep`, { pattern: 'needle', path: KB_DIR })).json()) as {
      matches: { path: string }[];
    };
    const paths = res.matches.map((m) => m.path);
    expect(paths).toContain(`${KB_DIR}/Knowledge/Public.md`);
    expect(paths).not.toContain(`${KB_DIR}/Knowledge/Secret.md`);
  });

  it('non-KB workspace files are never gated', async () => {
    // `a.md` lives at the workspace root, outside the KB dir → always readable.
    const base = await start('read', denyReads(new Set(['a.md'])));
    expect((await post(`${base}/api/agent/tools/read_file`, { path: 'a.md' })).status).toBe(200);
  });
});

/**
 * start_session must mint a REAL chat thread and return its id (not a bare
 * random UUID), so the same id works for KB reads AND for `ask` (whose
 * sessionId IS a chat thread). This is what unifies the ontology boundary
 * across reads + ask — see workspace.tools.ts start_session comment.
 */
describe('start_session', () => {
  // Minimal harness: own app + a fake ISessionSink that records createSession.
  let server: HttpServer | undefined;
  let created: Array<{ userId: string; startedAt: Date }> = [];

  async function startSessionApp(source: 'external' | 'internal' = 'external'): Promise<string> {
    created = [];
    const registry = new ToolRegistry();
    const resolve = async (auth: ToolAuth, signal: AbortSignal): Promise<ToolContext> => ({
      user: { id: 'user-42', email: 'e@x', name: 'N' },
      scope: auth.scope,
      source: auth.source,
      abortSignal: signal,
      workspaceService: {} as never,
      workflowService: {} as never,
      events: {} as never,
      getFilesystem: async () => ({}) as never,
    });
    const toolHandler = createToolHandlerFactory(resolve);
    const auth = (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      req.toolAuth = { source, userId: 'user-42', scope: 'write' };
      next();
    };
    // Fake ISessionSink: record the call, return a fixed session id.
    const fakeSessionSink = {
      createSession: async (userId: string, startedAt: Date) => {
        created.push({ userId, startedAt });
        return { sessionId: 'thread-xyz' };
      },
    };

    const app = express();
    app.use(express.json());
    const router = express.Router();
    registerWorkspaceTools(
      registry, router, auth, toolHandler,
      new SpillStore(join(tmpdir(), 'bevel-test-spills')), allowAll, KB_DIR,
      { service: {} as never, enabled: false, kbDirName: KB_DIR, recoveryBotEmail: 'recovery-bot@bevel.local', hooks: new WorkflowHooks() },
      new RoutineWritePolicyService(),
      fakeSessionSink,
    );
    app.use('/api', router);
    server = await new Promise<HttpServer>((r) => {
      const s = app.listen(0, () => r(s));
    });
    return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  }

  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  });

  it('returns the sink-minted id as sessionId', async () => {
    const base = await startSessionApp();
    const res = (await (await post(`${base}/api/agent/tools/start_session`)).json()) as { sessionId: string };
    expect(res.sessionId).toBe('thread-xyz');
  });

  it('mints the session for the authenticated user', async () => {
    const base = await startSessionApp();
    await post(`${base}/api/agent/tools/start_session`);
    expect(created).toHaveLength(1);
    expect(created[0].userId).toBe('user-42');
    expect(created[0].startedAt).toBeInstanceOf(Date);
  });

  it('rejects an internal-source caller (external-only) so an agent cannot mint a session mid-run', async () => {
    // Note: an OAuth/JWT MCP session is NOT this case — its `externalProxy`
    // loopback token resolves to source 'external' at the verifier (see
    // tool-auth), so it is admitted here like any external agent.
    const base = await startSessionApp('internal');
    const res = await post(`${base}/api/agent/tools/start_session`);
    expect(res.status).toBe(403);
    expect(created).toHaveLength(0);
  });
});

/**
 * Contract-level guarantee: `branch` is a REQUIRED input on every workspace tool
 * def, on BOTH the internal and external manuals — one convention everywhere, so
 * the caller always names the branch (there is no implied "current" workspace).
 * This is what stops a call from ever resolving a `undefined` workspace at the
 * schema layer, complementing the handler-level guard exercised above.
 */
describe('branch is a required parameter in the tool contract', () => {
  /** Register the workspace tools into a fresh registry (no server needed). */
  function buildRegistry(): ToolRegistry {
    const registry = new ToolRegistry();
    const router = express.Router();
    const noopAuth: express.RequestHandler = (_req, _res, next) => next();
    // The handler factory is only invoked to build routes; its output is never
    // called in this test, so a no-op express handler suffices.
    const toolHandler = (() => () => {}) as never;
    registerWorkspaceTools(
      registry,
      router,
      noopAuth,
      toolHandler,
      new SpillStore(join(tmpdir(), 'bevel-test-spills')),
      allowAll,
      KB_DIR,
      { service: {} as never, enabled: false, kbDirName: KB_DIR, recoveryBotEmail: 'recovery-bot@bevel.local', hooks: new WorkflowHooks() },
      new RoutineWritePolicyService(),
      {} as never,
    );
    return registry;
  }

  /** The flat input schema's `required` list (unwrapping `toolDef`'s `{ body }` envelope). */
  function bodyRequired(tool: { inputs?: unknown } | undefined): string[] {
    const inputs = tool?.inputs as { properties?: { body?: { required?: string[] } } } | undefined;
    return inputs?.properties?.body?.required ?? [];
  }

  it('execute_command declares branch required on the INTERNAL manual', async () => {
    const internal = await buildRegistry().listInternal();
    const exec = internal.find((t) => t.name === 'execute_command');
    expect(exec).toBeDefined();
    expect(bodyRequired(exec)).toContain('branch');
    expect(bodyRequired(exec)).toContain('command');
  });

  it('execute_command is internal-only — never advertised on the external manual', async () => {
    const external = await buildRegistry().listExternal();
    expect(external.find((t) => t.name === 'execute_command')).toBeUndefined();
  });

  it('every workspace file tool requires branch on BOTH manuals (one convention everywhere)', async () => {
    const registry = buildRegistry();
    const [internal, external] = await Promise.all([registry.listInternal(), registry.listExternal()]);
    const fileTools = [
      'read_file', 'write_file', 'write_files', 'edit_file', 'delete_file',
      'mkdir', 'move_file', 'copy_file', 'list_files', 'file_stat', 'grep', 'unzip',
    ];
    for (const name of fileTools) {
      const int = internal.find((t) => t.name === name);
      const ext = external.find((t) => t.name === name);
      expect(int, `${name} should be on the internal manual`).toBeDefined();
      expect(ext, `${name} should be on the external manual`).toBeDefined();
      expect(bodyRequired(int), `${name} internal requires branch`).toContain('branch');
      expect(bodyRequired(ext), `${name} external requires branch`).toContain('branch');
    }
  });
});
