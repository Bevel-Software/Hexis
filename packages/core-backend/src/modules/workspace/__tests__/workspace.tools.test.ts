import type { Server as HttpServer } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import AdmZip from 'adm-zip';
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
import { DocExtractService } from '../file-readers/doc-extract.service.js';
import type { IAccessControl } from '../../access/access-control.interface.js';
import { assertValidBranchName } from '../../kb-fs/branch-name.js';
import { AccessDeniedError } from '../../access-model/access-errors.js';

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
/** Fresh per-start doc-extraction cache root (OUTSIDE the workspace, like production). */
let docCacheDir = '';
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
/** The registry the tools were mounted into, so a test can inspect their defs. */
let toolRegistry: ToolRegistry;

async function start(
  scope: 'read' | 'write' = 'write',
  access: IAccessControl = allowAll,
): Promise<string> {
  tempDir = await mkdtemp(join(tmpdir(), 'ws-tools-'));
  docCacheDir = await mkdtemp(join(tmpdir(), 'ws-doc-cache-'));
  fs = new LocalFilesystem({ basePath: tempDir, contained: true });
  await fs.writeFile('a.md', 'hello\nworld\n');
  workspacePathCalls = [];
  writePolicy = new RoutineWritePolicyService();
  focusedBranch = undefined;

  const registry = new ToolRegistry();
  toolRegistry = registry;
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
  registerWorkspaceTools(registry, router, fakeAuth, toolHandler, new SpillStore(join(tmpdir(), 'bevel-test-spills')), new DocExtractService(docCacheDir), access, KB_DIR, {
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
  if (docCacheDir) {
    await rm(docCacheDir, { recursive: true, force: true });
    docCacheDir = '';
  }
});

/**
 * True once `pid` has been killed: either it is gone, or it is a zombie
 * waiting on a reaper (Linux: `State:\tZ` in /proc). `kill(pid, 0)` alone
 * cannot tell a zombie from a live process.
 */
async function isDeadOrZombie(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
  } catch {
    return true;
  }
  try {
    const status = await readFile(`/proc/${pid}/status`, 'utf8');
    return /^State:\s*Z/m.test(status);
  } catch {
    return false; // no /proc (macOS): alive as far as the signal says
  }
}

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

  // The command runs under `sh -c`; a timeout used to SIGKILL that shell and
  // leave what it had started running on as an orphan. The whole process
  // group goes now. POSIX only: Windows has no process groups to kill.
  it.skipIf(process.platform === 'win32')('execute_command kills what the command started, not just its shell, on timeout', async () => {
    const base = await start();
    // Print the grandchild's pid, then block on it so the timeout fires. The
    // timeout is the schema's minimum — inside the tool's declared contract,
    // and long enough that a slow spawn still prints the pid before it fires.
    const res = (await (
      await post(`${base}/api/agent/tools/execute_command`, {
        branch: 'main',
        command: 'sleep 30 & echo $!; wait',
        timeout_ms: 1000,
      })
    ).json()) as { stdout: string; exitCode: number };
    expect(res.exitCode).toBe(-1);
    const grandchild = Number(res.stdout.trim());
    expect(grandchild).toBeGreaterThan(0);
    // Dead means killed, not reaped: a SIGKILLed process keeps its pid — and
    // answers `kill(pid, 0)` as alive — until whoever inherited it reaps it,
    // and on a host with no reaper (the very thing this guards) that is
    // never. So where /proc exists, a zombie (`State: Z`) counts as dead; a
    // vanished pid counts everywhere. Poll to a deadline rather than trust
    // one fixed pause. Without the fix the grandchild is still sleeping at
    // the deadline, so what fails is the deadline — never an early check.
    const deadline = Date.now() + 3_000;
    let dead = false;
    while (!dead && Date.now() < deadline) {
      dead = await isDeadOrZombie(grandchild);
      if (!dead) await new Promise((r) => setTimeout(r, 50));
    }
    expect(dead).toBe(true);
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

  // POSIX-only probes: `$GIT_DIR` expansion and `>/dev/null` are `sh`
  // semantics, and `shell: true` on Windows runs cmd.exe, where the probe
  // itself (not the scoping under test) is meaningless. CI runs Linux.
  it.skipIf(process.platform === 'win32')('execute_command does not leak GIT_DIR into non-git commands', async () => {
    const base = await start();
    // The KB-clone GIT_DIR/GIT_WORK_TREE override is scoped to bare `git …`
    // only; a non-git command (e.g. npm/pip that shells git internally) must
    // NOT inherit it, or the nested git child would target the KB clone.
    // Probe via `node -e` rather than shell expansion — the override lives in
    // the spawn env, and `$GIT_DIR` syntax doesn't expand under cmd.exe.
    const res = (await (await post(`${base}/api/agent/tools/execute_command`, { branch: 'main', command: `node -e "console.log('GIT_DIR=['+(process.env.GIT_DIR||'')+']')"` })).json()) as { stdout: string; stderr: string; exitCode: number };
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe('GIT_DIR=[]');
  });

  it.skipIf(process.platform === 'win32')('execute_command does not leak GIT_DIR into a chained step after git', async () => {
    const base = await start();
    // Runs under `shell: true`, so a command that merely STARTS with git but
    // chains another step must not export the KB git env to the whole shell —
    // otherwise `git … && npm ci` would leak the KB repo context into the npm/pip
    // git subprocess. `git --version` needs no repo, so exit stays 0. The
    // version line lands on stdout (`>/dev/null` isn't portable to cmd.exe),
    // so the leak probe is asserted on the LAST line.
    const res = (await (await post(`${base}/api/agent/tools/execute_command`, { branch: 'main', command: `git --version && node -e "console.log('leak=['+(process.env.GIT_DIR||'')+']')"` })).json()) as { stdout: string; stderr: string; exitCode: number };
    expect(res.exitCode).toBe(0);
    const lines = res.stdout.trim().split(/\r?\n/);
    expect(lines[lines.length - 1].trim()).toBe('leak=[]');
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
 * `grep` given a `path` that names a FILE. The walk begins with `readdir`,
 * which fails on a file and on an absent path alike — so such a grep used to
 * answer an empty match list, indistinguishable from "your pattern is not in
 * there". Every case now answers honestly: the file's matches, a note when
 * there was no text to search, or an error when there is nothing at the path.
 */
describe('grep with a path that names a file', () => {
  interface GrepResult {
    matches: { path: string; line: number; text: string }[];
    truncated: boolean;
    note?: string;
  }
  const grep = async (base: string, body: Record<string, unknown>): Promise<GrepResult> =>
    (await (await post(`${base}/api/agent/tools/grep`, body)).json()) as GrepResult;

  it('searches exactly that file — the match carries that path and a 1-based line number', async () => {
    const base = await start();
    await fs.writeFile('notes/deep.md', 'alpha\nbeta needle\ngamma\n');
    // A sibling holding the same term: a file grep must not reach it.
    await fs.writeFile('notes/other.md', 'needle elsewhere\n');
    const res = await grep(base, { pattern: 'needle', path: 'notes/deep.md' });
    expect(res.matches).toEqual([{ path: 'notes/deep.md', line: 2, text: 'beta needle' }]);
    expect(res.truncated).toBe(false);
    expect(res.note).toBeUndefined();
  });

  it('a file the pattern is simply not in is an empty SUCCESS — no note, no error', async () => {
    const base = await start();
    const res = await grep(base, { pattern: 'absent-term', path: 'a.md' });
    expect(res.matches).toEqual([]);
    expect(res.truncated).toBe(false);
    expect(res.note).toBeUndefined();
  });

  it('caps a file grep at max_results and reports truncated, exactly as a directory grep does', async () => {
    const base = await start();
    await fs.writeFile('many.md', 'needle\n'.repeat(5));
    const res = await grep(base, { pattern: 'needle', path: 'many.md', max_results: 2 });
    expect(res.matches.map((m) => m.line)).toEqual([1, 2]);
    expect(res.truncated).toBe(true);
  });

  it('a file with no searchable text returns empty matches plus a note saying so', async () => {
    const base = await start();
    // "needle" followed by a NUL byte: binary content, so nothing to search —
    // the byte pattern is present but the file is not text.
    await fs.writeFile('data.bin', Buffer.from('needle\0tail', 'latin1'));
    await fs.writeFile(
      'logo.png',
      Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'),
    );
    for (const path of ['data.bin', 'logo.png']) {
      const res = await grep(base, { pattern: 'needle', path });
      expect(res.matches, path).toEqual([]);
      expect(res.note, path).toContain('no searchable text');
      expect(res.note, path).toContain(path);
    }
  });

  it('a path with nothing at it fails with an error naming the path — never an empty success', async () => {
    const base = await start();
    const res = await post(`${base}/api/agent/tools/grep`, { pattern: 'needle', path: 'notes/ghost.md' });
    expect(res.status).toBe(404);
    const { error } = (await res.json()) as { error: string };
    expect(error).toContain('notes/ghost.md');
  });

  it('a FILE the caller may not read answers exactly as read_file does — same status, same body', async () => {
    const secret = `${KB_DIR}/Knowledge/Secret.md`;
    // Denied AND absent: the two tools must agree here too, or grep's error
    // would reveal an existence read_file refuses to confirm.
    const ghost = `${KB_DIR}/Knowledge/Ghost.md`;
    const base = await start('write', denyReads(new Set(['Knowledge/Secret.md', 'Knowledge/Ghost.md'])));
    await fs.writeFile(secret, 'secret needle\n');
    for (const path of [secret, ghost]) {
      const [readRes, grepRes] = await Promise.all([
        post(`${base}/api/agent/tools/read_file`, { path }),
        post(`${base}/api/agent/tools/grep`, { pattern: 'needle', path }),
      ]);
      expect(grepRes.status, path).toBe(403);
      expect(grepRes.status, path).toBe(readRes.status);
      expect(await grepRes.json(), path).toEqual(await readRes.json());
    }
  });

  it('a path UNDER an existing file is nothing-there too — the same 404, not a raw failure', async () => {
    const base = await start();
    await fs.writeFile('notes/deep.md', 'alpha\n');
    // `notes/deep.md` is a FILE, so the filesystem answers ENOTDIR rather than
    // ENOENT. Nothing can live at this path either, so it earns the same
    // honest 404 as a plainly absent one.
    const res = await post(`${base}/api/agent/tools/grep`, {
      pattern: 'needle',
      path: 'notes/deep.md/deeper.md',
    });
    expect(res.status).toBe(404);
    const { error } = (await res.json()) as { error: string };
    expect(error).toContain('notes/deep.md/deeper.md');
  });

  it("a denied path the filesystem cannot even stat still answers with read_file's 403", async () => {
    const loop = `${KB_DIR}/Knowledge/Loop.md`;
    const base = await start('write', denyReads(new Set(['Knowledge/Loop.md'])));
    await mkdir(join(tempDir, KB_DIR, 'Knowledge'), { recursive: true });
    // A symlink pointing at ITSELF: stat fails with ELOOP — neither absence
    // nor a readable file. The permission verdict must still come FIRST, or
    // grep would leak a filesystem complaint where read_file says only 403.
    await symlink('Loop.md', join(tempDir, loop));
    const [readRes, grepRes] = await Promise.all([
      post(`${base}/api/agent/tools/read_file`, { path: loop }),
      post(`${base}/api/agent/tools/grep`, { pattern: 'needle', path: loop }),
    ]);
    expect(grepRes.status).toBe(403);
    expect(grepRes.status).toBe(readRes.status);
    expect(await grepRes.json()).toEqual(await readRes.json());
  });

  it('a READABLE path the filesystem cannot resolve fails exactly as read_file fails', async () => {
    const loop = `${KB_DIR}/Knowledge/Tangle.md`;
    const base = await start();
    await mkdir(join(tempDir, KB_DIR, 'Knowledge'), { recursive: true });
    await symlink('Tangle.md', join(tempDir, loop));
    const [readRes, grepRes] = await Promise.all([
      post(`${base}/api/agent/tools/read_file`, { path: loop }),
      post(`${base}/api/agent/tools/grep`, { pattern: 'needle', path: loop }),
    ]);
    // The gate allows it, so the READ is what answers — and it is the same
    // `fs.readFile` read_file calls. grep must not dress that up as absence
    // (a false 404), nor invent a failure of its own: one path, one story.
    expect(grepRes.status).toBe(readRes.status);
    expect(await grepRes.json()).toEqual(await readRes.json());
  });

  it('a DIRECTORY path still walks the whole subtree (unchanged)', async () => {
    const base = await start();
    await fs.writeFile('notes/one.md', 'needle here\n');
    await fs.writeFile('notes/sub/two.md', 'and needle there\n');
    await fs.writeFile('outside.md', 'needle outside the subtree\n');
    const res = await grep(base, { pattern: 'needle', path: 'notes' });
    expect(res.matches.map((m) => m.path).sort()).toEqual(['notes/one.md', 'notes/sub/two.md']);
    expect(res.note).toBeUndefined();
  });
});

/**
 * Document reading: read_file/grep consume the doc-extract service for office
 * documents and PDFs; the agent text-editing tools refuse them. Fixtures are
 * REAL files built in-test (a docx is just a zip with word/document.xml).
 */
describe('office documents and PDFs', () => {
  const docx = (...paragraphs: string[]): Buffer => {
    const zip = new AdmZip();
    zip.addFile('[Content_Types].xml', Buffer.from('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'));
    zip.addFile(
      'word/document.xml',
      Buffer.from(
        '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
          paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join('') +
          '</w:body></w:document>',
      ),
    );
    return zip.toBuffer();
  };

  const pptx = (slides: string[][]): Buffer => {
    const zip = new AdmZip();
    zip.addFile('[Content_Types].xml', Buffer.from('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'));
    slides.forEach((paragraphs, i) => {
      zip.addFile(
        `ppt/slides/slide${i + 1}.xml`,
        Buffer.from(
          '<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:txBody>' +
            paragraphs.map((p) => `<a:p><a:r><a:t>${p}</a:t></a:r></a:p>`).join('') +
            '</p:txBody></p:sld>',
        ),
      );
    });
    return zip.toBuffer();
  };

  /** Minimal valid one-page PDF with `text` as its text layer. */
  const pdf = (text: string): Buffer => {
    const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ];
    let out = '%PDF-1.4\n';
    const offsets: number[] = [];
    for (let i = 0; i < objects.length; i++) {
      offsets.push(out.length);
      out += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
    }
    const xrefStart = out.length;
    out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
    out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
    return Buffer.from(out, 'latin1');
  };

  /** Minimal ODF package: a zip with a `content.xml` carrying `body` under `<office:body>`. */
  const odf = (body: string): Buffer => {
    const zip = new AdmZip();
    zip.addFile(
      'content.xml',
      Buffer.from(
        '<?xml version="1.0"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ' +
          'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" ' +
          'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0">' +
          `<office:body>${body}</office:body></office:document-content>`,
      ),
    );
    return zip.toBuffer();
  };

  const odt = (...paragraphs: string[]): Buffer =>
    odf(`<office:text>${paragraphs.map((p) => `<text:p>${p}</text:p>`).join('')}</office:text>`);

  const odp = (slides: string[][]): Buffer =>
    odf(
      '<office:presentation>' +
        slides
          .map(
            (paragraphs) =>
              `<draw:page><draw:frame><draw:text-box>${paragraphs.map((p) => `<text:p>${p}</text:p>`).join('')}</draw:text-box></draw:frame></draw:page>`,
          )
          .join('') +
        '</office:presentation>',
    );

  const ods = (name: string, rows: string[][]): Buffer =>
    odf(
      `<office:spreadsheet><table:table table:name="${name}">` +
        rows
          .map((cells) => `<table:table-row>${cells.map((c) => `<table:table-cell><text:p>${c}</text:p></table:table-cell>`).join('')}</table:table-row>`)
          .join('') +
        '</table:table></office:spreadsheet>',
    );

  const readContent = async (base: string, path: string, extra: Record<string, unknown> = {}): Promise<string> => {
    const res = (await (await post(`${base}/api/agent/tools/read_file`, { path, ...extra })).json()) as { content: string };
    return res.content;
  };

  it('read_file returns marker + extracted text for a docx', async () => {
    const base = await start();
    await fs.writeFile('report.docx', docx('Hello from Word', 'Second paragraph'));
    const content = await readContent(base, 'report.docx');
    const lines = content.split('\n');
    expect(lines[0]).toMatch(/^\[extracted text of report\.docx — 2 paragraphs;/);
    expect(lines[0]).toContain('layout, images and formatting omitted');
    expect(lines.slice(1)).toEqual(['Hello from Word', 'Second paragraph']);
  });

  it('read_file slices offset/limit AFTER assembling marker + text (unchanged semantics)', async () => {
    const base = await start();
    await fs.writeFile('report.docx', docx('Sliceable content here'));
    const full = await readContent(base, 'report.docx');
    const sliced = await readContent(base, 'report.docx', { offset: 5, limit: 12 });
    expect(sliced).toBe(full.slice(5, 17));
  });

  it('read_file returns [page N] text for a PDF', async () => {
    const base = await start();
    await fs.writeFile('paper.pdf', pdf('Findings inside a PDF'));
    const content = await readContent(base, 'paper.pdf');
    expect(content).toMatch(/^\[extracted text of paper\.pdf — 1 page;/);
    expect(content).toContain('[page 1]\nFindings inside a PDF');
  });

  it('grep finds a term inside a pptx, with the [slide N] marker line locating it', async () => {
    const base = await start();
    await fs.writeFile('deck.pptx', pptx([['Intro'], ['Roadmap 2026', 'Ship documents']]));
    const res = (await (await post(`${base}/api/agent/tools/grep`, { pattern: 'Roadmap' })).json()) as {
      matches: { path: string; line: number; text: string }[];
      note?: string;
    };
    expect(res.matches).toContainEqual(expect.objectContaining({ path: 'deck.pptx', text: 'Roadmap 2026' }));
    // The extraction reads: marker line 1, [slide 1] line 2, Intro line 3,
    // [slide 2] line 4, Roadmap line 5 — grep reports the extraction's numbers.
    expect(res.matches.find((m) => m.text === 'Roadmap 2026')?.line).toBe(5);
    // The structure markers themselves are searchable.
    const markers = (await (await post(`${base}/api/agent/tools/grep`, { pattern: '\\[slide 2\\]' })).json()) as { matches: { path: string }[] };
    expect(markers.matches).toContainEqual(expect.objectContaining({ path: 'deck.pptx' }));
    expect(res.note).toBeUndefined();
  });

  it('grep on a path naming a DOCUMENT searches its extraction the way the walk does — markers included', async () => {
    const base = await start();
    await fs.writeFile('deck.pptx', pptx([['Intro'], ['Roadmap 2026']]));
    // A second deck carrying the same term: a file grep must not reach it.
    await fs.writeFile('decoy.pptx', pptx([['Roadmap 2026 decoy deck']]));
    const res = (await (await post(`${base}/api/agent/tools/grep`, { pattern: 'Roadmap', path: 'deck.pptx' })).json()) as {
      matches: { path: string; line: number; text: string }[];
      note?: string;
    };
    // Same line arithmetic as the directory grep: marker 1, [slide 1] 2,
    // Intro 3, [slide 2] 4, Roadmap 5.
    expect(res.matches).toEqual([{ path: 'deck.pptx', line: 5, text: 'Roadmap 2026' }]);
    expect(res.note).toBeUndefined();
    // The structure markers are searchable on the single-file path too.
    const markers = (await (await post(`${base}/api/agent/tools/grep`, { pattern: '\\[slide 2\\]', path: 'deck.pptx' })).json()) as {
      matches: { path: string; line: number }[];
    };
    expect(markers.matches).toEqual([expect.objectContaining({ path: 'deck.pptx', line: 4 })]);
  });

  it('grep on a path naming a CORRUPT document notes it has no searchable text', async () => {
    const base = await start();
    await fs.writeFile('broken.docx', Buffer.from('not really a zip'));
    const res = (await (await post(`${base}/api/agent/tools/grep`, { pattern: 'zip', path: 'broken.docx' })).json()) as {
      matches: unknown[];
      note?: string;
    };
    expect(res.matches).toEqual([]);
    expect(res.note).toContain('no searchable text');
    expect(res.note).toContain('broken.docx');
  });

  it('grep extracts at most 20 uncached documents per call and notes the skipped rest; a re-run covers them', async () => {
    const base = await start();
    for (let i = 0; i < 22; i++) {
      // Distinct content per file — identical bytes would share one cache entry
      // and the walk would extract only once.
      await fs.writeFile(`docs/f${String(i).padStart(2, '0')}.docx`, docx(`needle-${i} unique body ${i}`));
    }
    const first = (await (await post(`${base}/api/agent/tools/grep`, { pattern: 'needle-' })).json()) as {
      matches: unknown[];
      note?: string;
    };
    expect(first.matches).toHaveLength(20);
    expect(first.note).toContain('2 document(s) (office/PDF/email files) were not searched');
    // Second run: 20 are cached (free), budget covers the remaining 2.
    const second = (await (await post(`${base}/api/agent/tools/grep`, { pattern: 'needle-' })).json()) as {
      matches: unknown[];
      note?: string;
    };
    expect(second.matches).toHaveLength(22);
    expect(second.note).toBeUndefined();
  });

  it('read_file returns marker + extracted text for the three OpenDocument formats', async () => {
    const base = await start();
    await fs.writeFile('memo.odt', odt('Hello from Writer', 'Second paragraph'));
    const odtContent = await readContent(base, 'memo.odt');
    expect(odtContent.split('\n')).toEqual([
      '[extracted text of memo.odt — 2 paragraphs; layout, images and formatting omitted]',
      'Hello from Writer',
      'Second paragraph',
    ]);

    await fs.writeFile('deck.odp', odp([['Impress intro'], ['Second page']]));
    const odpContent = await readContent(base, 'deck.odp');
    expect(odpContent).toMatch(/^\[extracted text of deck\.odp — 2 slides;/);
    expect(odpContent).toContain('[slide 1]\nImpress intro\n[slide 2]\nSecond page');

    await fs.writeFile('numbers.ods', ods('Inventory', [['Name', 'Qty'], ['Widget', '3']]));
    const odsContent = await readContent(base, 'numbers.ods');
    expect(odsContent).toMatch(/^\[extracted text of numbers\.ods — 1 sheet, rows as tab-separated values;/);
    expect(odsContent).toContain('[sheet: Inventory]\nName\tQty\nWidget\t3');
  });

  it('grep finds a term inside an odp, with the [slide N] marker line locating it', async () => {
    const base = await start();
    await fs.writeFile('deck.odp', odp([['Intro'], ['Roadmap 2027', 'Ship OpenDocument']]));
    const res = (await (await post(`${base}/api/agent/tools/grep`, { pattern: 'Roadmap' })).json()) as {
      matches: { path: string; line: number; text: string }[];
    };
    // Extraction: marker line 1, [slide 1] 2, Intro 3, [slide 2] 4, Roadmap 5.
    expect(res.matches).toContainEqual(expect.objectContaining({ path: 'deck.odp', text: 'Roadmap 2027', line: 5 }));
    const markers = (await (await post(`${base}/api/agent/tools/grep`, { pattern: '\\[slide 2\\]' })).json()) as { matches: { path: string }[] };
    expect(markers.matches).toContainEqual(expect.objectContaining({ path: 'deck.odp' }));
  });

  it('read_file answers a corrupt odt zip with an honest could-not-parse message (no 500)', async () => {
    const base = await start();
    await fs.writeFile('broken.odt', Buffer.from('not really a zip'));
    const res = await post(`${base}/api/agent/tools/read_file`, { path: 'broken.odt' });
    expect(res.status).toBe(200);
    const { content } = (await res.json()) as { content: string };
    expect(content).toContain('could not be parsed as a .odt');
    expect(content).toContain('uploading a new version');
  });

  // Hand-written MIME — the email fixtures need no builder library.
  const eml = (subject: string, body: string): Buffer =>
    Buffer.from(
      [
        'From: Ada Lovelace <ada@example.com>',
        'To: bob@example.com',
        `Subject: ${subject}`,
        'Date: Mon, 5 Jan 2026 10:00:00 +0000',
        'Content-Type: text/plain; charset=utf-8',
        '',
        body,
      ].join('\r\n'),
    );

  it('read_file returns marker + [from]/[subject] header block + body for a .eml email', async () => {
    const base = await start();
    await fs.writeFile('Inbox/offer.eml', eml('Quarterly numbers', 'Please see the summary.'));
    const content = await readContent(base, 'Inbox/offer.eml');
    expect(content.split('\n')).toEqual([
      '[extracted text of Inbox/offer.eml — email message; formatting and full headers omitted]',
      '[from] Ada Lovelace <ada@example.com>',
      '[to] bob@example.com',
      '[subject] Quarterly numbers',
      '[date] 2026-01-05T10:00:00.000Z',
      '',
      'Please see the summary.',
    ]);
  });

  it('grep finds a term inside a .eml, with the [subject] header line itself searchable', async () => {
    const base = await start();
    await fs.writeFile('Inbox/offer.eml', eml('Quarterly numbers', 'The needle-2026 is in the body.'));
    const res = (await (await post(`${base}/api/agent/tools/grep`, { pattern: 'needle-2026' })).json()) as {
      matches: { path: string; line: number; text: string }[];
    };
    // Extraction: marker 1, [from] 2, [to] 3, [subject] 4, [date] 5, blank 6, body 7.
    expect(res.matches).toContainEqual(
      expect.objectContaining({ path: 'Inbox/offer.eml', text: 'The needle-2026 is in the body.', line: 7 }),
    );
    const header = (await (await post(`${base}/api/agent/tools/grep`, { pattern: '\\[subject\\] Quarterly' })).json()) as {
      matches: { path: string; line: number }[];
    };
    expect(header.matches).toContainEqual(expect.objectContaining({ path: 'Inbox/offer.eml', line: 4 }));
  });

  it('write_file / edit_file refuse email files with the snapshot explanation', async () => {
    const base = await start();
    await fs.writeFile('Inbox/offer.eml', eml('original', 'original body'));
    for (const [tool, body] of [
      ['write_file', { path: 'Inbox/offer.eml', content: 'rewritten' }],
      ['write_file', { path: 'Inbox/new-thread.msg', content: 'plain text' }],
      ['edit_file', { path: 'Inbox/offer.eml', old_string: 'original', new_string: 'changed' }],
    ] as const) {
      const res = await post(`${base}/api/agent/tools/${tool}`, body);
      expect(res.status, tool).toBe(400);
      const { error } = (await res.json()) as { error: string };
      expect(error, tool).toContain('email file');
      expect(error, tool).toContain('snapshot');
      expect(error, tool).toContain('uploading a new version');
    }
    // The email is untouched: reading it still extracts the original text.
    expect(await readContent(base, 'Inbox/offer.eml')).toContain('original body');
  });

  it('read_file answers a corrupt .msg with an honest could-not-parse message (no 500)', async () => {
    const base = await start();
    await fs.writeFile('Inbox/broken.msg', Buffer.from('not a CFB container'));
    const res = await post(`${base}/api/agent/tools/read_file`, { path: 'Inbox/broken.msg' });
    expect(res.status).toBe(200);
    const { content } = (await res.json()) as { content: string };
    expect(content).toContain('could not be parsed as a .msg');
    expect(content).toContain('uploading a new version');
  });

  it('read_file answers a corrupt docx with an honest could-not-parse message (no 500)', async () => {
    const base = await start();
    await fs.writeFile('broken.docx', Buffer.from('not really a zip'));
    const res = await post(`${base}/api/agent/tools/read_file`, { path: 'broken.docx' });
    expect(res.status).toBe(200);
    const { content } = (await res.json()) as { content: string };
    expect(content).toContain('could not be parsed as a .docx');
    expect(content).toContain('uploading a new version');
  });

  it('read_file answers a legacy .doc with the convert-to-modern hint', async () => {
    const base = await start();
    await fs.writeFile('old.doc', Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0x00, 0x01, 0x02]));
    const content = await readContent(base, 'old.doc');
    expect(content).toContain('legacy office format');
    expect(content).toContain('.docx');
  });

  it('edit_file / write_file refuse a legacy .doc with the convert-or-replace message — a binary the reader cannot extract must never be text-overwritten', async () => {
    const base = await start();
    await fs.writeFile('old.doc', Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0x00, 0x01, 0x02]));
    for (const [tool, body] of [
      ['edit_file', { path: 'old.doc', old_string: 'a', new_string: 'b' }],
      ['write_file', { path: 'old.doc', content: 'plain text' }],
    ] as const) {
      const res = await post(`${base}/api/agent/tools/${tool}`, body);
      expect(res.status, tool).toBe(400);
      const { error } = (await res.json()) as { error: string };
      expect(error, tool).toContain('legacy binary office format');
      expect(error, tool).toContain('.docx');
      expect(error, tool).toContain('uploading a new version');
    }
  });

  it('write_file / edit_file refuse to overwrite BINARY content under any extension', async () => {
    // read_file answers a NUL-bearing file with a notice instead of its bytes.
    // A write gate that only asked about the EXTENSION let an agent overwrite
    // exactly those bytes — destroying a file it was never allowed to see.
    const base = await start();
    await fs.writeFile('blob.dat', Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff]));
    for (const [tool, body] of [
      ['write_file', { path: 'blob.dat', content: 'plain text' }],
      ['edit_file', { path: 'blob.dat', old_string: 'a', new_string: 'b' }],
    ] as const) {
      const res = await post(`${base}/api/agent/tools/${tool}`, body);
      expect(res.status, tool).toBe(400);
      const { error } = (await res.json()) as { error: string };
      expect(error, tool).toContain('binary content');
      expect(error, tool).toContain('uploading a new version');
    }
    // …and a TEXT file under the same fallback reader still writes normally.
    const ok = await post(`${base}/api/agent/tools/write_file`, { path: 'notes.dat', content: 'hello' });
    expect(ok.status).toBe(200);
  });

  it('read_file answers other binary files with a one-line notice (zip names the unzip tool)', async () => {
    const base = await start();
    // .mp3, not an image: images return native MCP image content (see below).
    await fs.writeFile('song.mp3', Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00]));
    const mp3 = await readContent(base, 'song.mp3');
    expect(mp3).toBe('[song.mp3 is a binary file (audio/mpeg, 9 bytes) — not readable as text.]');
    await fs.writeFile('bundle.zip', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]));
    const zip = await readContent(base, 'bundle.zip');
    expect(zip).toContain('application/zip');
    expect(zip).toContain('unzip tool');
  });

  it('write_file / edit_file / write_files refuse document extensions with the round-trip explanation', async () => {
    const base = await start();
    await fs.writeFile('deck.pptx', pptx([['Original']]));
    for (const [tool, body] of [
      ['write_file', { path: 'new.docx', content: 'plain text' }],
      ['write_file', { path: 'new.odt', content: 'plain text' }],
      ['write_file', { path: 'slides.odp', content: 'plain text' }],
      ['edit_file', { path: 'deck.pptx', old_string: 'Original', new_string: 'Changed' }],
      ['edit_file', { path: 'numbers.ods', old_string: 'a', new_string: 'b' }],
      ['write_files', { files: [{ path: 'ok.md', content: 'fine' }, { path: 'sheet.xlsx', content: 'nope' }] }],
      ['write_files', { files: [{ path: 'ok.md', content: 'fine' }, { path: 'sheet.ods', content: 'nope' }] }],
    ] as const) {
      const res = await post(`${base}/api/agent/tools/${tool}`, body);
      expect(res.status, tool).toBe(400);
      const { error } = (await res.json()) as { error: string };
      expect(error, tool).toContain('EXTRACTED text');
      expect(error, tool).toContain('uploading a new version');
    }
    // The batch was refused atomically — the innocent .md was not written either.
    expect((await post(`${base}/api/agent/tools/read_file`, { path: 'ok.md' })).status).not.toBe(200);
    // And the pptx is untouched: reading it still extracts the original text.
    expect(await readContent(base, 'deck.pptx')).toContain('Original');
  });

  it('the write tools DESCRIBE every refused family — modern, legacy binary, and the upload path — so agents learn before the call', async () => {
    await start();
    const tools = await toolRegistry.listInternal();
    for (const name of ['write_file', 'write_files', 'edit_file']) {
      const def = tools.find((t) => t.name === name);
      expect(def, name).toBeDefined();
      // Modern extractable formats…
      expect(def!.description, name).toContain('.docx/.pptx/.xlsx/.odt/.odp/.ods/.pdf');
      // …email files (extractions too, so the same refusal applies)…
      expect(def!.description, name).toContain('.eml/.msg');
      // …the legacy binary family the refusal also covers…
      expect(def!.description, name).toContain('.doc/.ppt/.xls');
      // …and the replace-by-upload way out.
      expect(def!.description, name).toContain('uploading a new version');
    }
  });

  it('the page-writing tools say where images go, so an agent writes the link a page will render', async () => {
    await start();
    const tools = await toolRegistry.listInternal();
    for (const name of ['write_file', 'write_files']) {
      const def = tools.find((t) => t.name === name);
      expect(def, name).toBeDefined();
      expect(def!.description, name).toContain('`assets/` folder next to the page');
      expect(def!.description, name).toContain('![Approval screen](./assets/approval-screen.png)');
    }
  });
});

/**
 * Image reads: `read_file` on an image returns the `McpImageResult` sentinel
 * (base64 + mimeType + self-describing note) that the MCP result shaping turns
 * into a native image content block — never raw bytes and never the binary
 * notice. Real fixtures: a genuine 1×1 PNG and 1×1 GIF.
 */
describe('images', () => {
  /** A real, complete 1×1 transparent PNG. */
  const PNG_1X1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  );
  /** A real, complete 1×1 GIF89a. */
  const GIF_1X1 = Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64');

  interface ImageSentinel {
    kind: string;
    data: string;
    mimeType: string;
    note: string;
  }

  it('read_file on a png returns the image sentinel with base64, mimeType and a note naming path + dimensions + size', async () => {
    const base = await start();
    await fs.writeFile('logo.png', PNG_1X1);
    const res = await post(`${base}/api/agent/tools/read_file`, { path: 'logo.png' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ImageSentinel;
    expect(body.kind).toBe('bevel/mcp-image@v1');
    expect(body.mimeType).toBe('image/png');
    expect(body.data).toBe(PNG_1X1.toString('base64'));
    expect(body.note).toContain('logo.png');
    expect(body.note).toContain('image/png');
    expect(body.note).toContain(`${PNG_1X1.length} bytes`);
    expect(body.note).toContain('1×1 px');
  });

  it('read_file passes a gif through whole under the same cap (first frame is the client’s concern)', async () => {
    const base = await start();
    await fs.writeFile('anim.gif', GIF_1X1);
    const body = (await (await post(`${base}/api/agent/tools/read_file`, { path: 'anim.gif' })).json()) as ImageSentinel;
    expect(body.kind).toBe('bevel/mcp-image@v1');
    expect(body.mimeType).toBe('image/gif');
    expect(body.data).toBe(GIF_1X1.toString('base64'));
    expect(body.note).toContain('1×1 px');
  });

  it('read_file maps .jpg/.jpeg to image/jpeg (dimensions omitted when the header has none to give)', async () => {
    const base = await start();
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]); // SOI + EOI, no frame header
    await fs.writeFile('photo.jpg', bytes);
    const body = (await (await post(`${base}/api/agent/tools/read_file`, { path: 'photo.jpg' })).json()) as ImageSentinel;
    expect(body.mimeType).toBe('image/jpeg');
    expect(body.data).toBe(bytes.toString('base64'));
    expect(body.note).toBe(`[image: photo.jpg — image/jpeg, ${bytes.length} bytes]`);
  });

  it('read_file refuses an image over 3.5 MiB raw with the downscale message, not a sentinel', async () => {
    const base = await start();
    // 3,670,016 is the cap; one byte over must refuse. PNG magic + zero fill.
    const big = Buffer.alloc(3_670_017);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(big);
    await fs.writeFile('huge.png', big);
    const res = await post(`${base}/api/agent/tools/read_file`, { path: 'huge.png' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string; content: string };
    expect(body.path).toBe('huge.png');
    expect(body.content).toContain('too large to return over MCP');
    expect(body.content).toContain('3670016 bytes');
    expect(body.content).toContain('Downscale');
    expect(body.content).not.toContain(big.toString('base64').slice(0, 40));
  });

  it('read_file keeps .svg on the TEXT path — it is markup, not an image block', async () => {
    const base = await start();
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>';
    await fs.writeFile('icon.svg', svg);
    expect(await (await post(`${base}/api/agent/tools/read_file`, { path: 'icon.svg' })).json()).toEqual({
      path: 'icon.svg',
      content: svg,
    });
  });

  it('read_file on an image still honors the read gate (403 before any bytes are returned)', async () => {
    const base = await start('write', denyReads(new Set(['Knowledge/Secret.png'])));
    await fs.writeFile(`${KB_DIR}/Knowledge/Secret.png`, PNG_1X1);
    const res = await post(`${base}/api/agent/tools/read_file`, { path: `${KB_DIR}/Knowledge/Secret.png` });
    expect(res.status).toBe(403);
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
      new SpillStore(join(tmpdir(), 'bevel-test-spills')), new DocExtractService(join(tmpdir(), 'bevel-test-doc-extract')), allowAll, KB_DIR,
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
      new DocExtractService(join(tmpdir(), 'bevel-test-doc-extract')),
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

/**
 * The tools are rooted at the WORKSPACE dir, one level above the git clone, so
 * a path has to start with the clone folder to reach git at all. Every place an
 * agent reads before choosing a path says so, in the `path` input itself rather
 * than only in prose it may not read: the root listing (where the folder is
 * discoverable) and each content-writing tool.
 */
describe('path inputs tell the agent about the repository folder', () => {
  // `toolDef` wraps a tool's inputs under a single `body` property.
  const inputDescription = (def: { inputs?: unknown } | undefined, ...keys: string[]): string => {
    let node = (def?.inputs ?? {}) as Record<string, unknown>;
    for (const key of ['body', ...keys]) {
      node = ((node.properties as Record<string, unknown> | undefined)?.[key] ?? {}) as Record<string, unknown>;
      if (key === 'files') node = (node.items ?? {}) as Record<string, unknown>;
    }
    return typeof node.description === 'string' ? node.description : '';
  };

  it('every content-writing tool says paths start with `knowledge-base/`, so a repo-relative path is never guessed', async () => {
    await start();
    const tools = await toolRegistry.listInternal();
    const byName = (name: string) => {
      const def = tools.find((t) => t.name === name);
      expect(def, name).toBeDefined();
      return def;
    };
    for (const name of ['write_file', 'edit_file', 'mkdir', 'delete_file', 'unzip']) {
      expect(inputDescription(byName(name), 'path'), name).toContain(`\`${KB_DIR}/\``);
    }
    expect(inputDescription(byName('write_files'), 'files', 'path'), 'write_files').toContain(`\`${KB_DIR}/\``);
    for (const name of ['move_file', 'copy_file']) {
      expect(inputDescription(byName(name), 'dest'), name).toContain(`\`${KB_DIR}/\``);
    }
  });

  it('the root listing names the clone folder, so an agent that lists first learns the prefix', async () => {
    await start();
    const tools = await toolRegistry.listInternal();
    const list = tools.find((t) => t.name === 'list_files');
    expect(list).toBeDefined();
    expect(list!.description).toContain(`\`${KB_DIR}/\``);
    expect(inputDescription(list, 'path')).toContain(`\`${KB_DIR}/\``);
  });
});

/**
 * The safety contract an agent gets before a move or delete: `file_stat` says
 * what an item is and what the caller may do with it, `move_file` and
 * `delete_folder` answer a dry run with the impact and wait for `confirm`, and
 * a permission refusal says whether and how to propose instead. The access
 * double below stands in for the rules, per top-level KB folder:
 *   Sales/  — everything (the default for anything unlisted)
 *   HR/     — read + write, no download, no owner: a move here changes access
 *   Locked/ — read only: writes are refused, proposing is possible
 *   Secret/ — nothing: writes are refused, proposing is not
 *   …/sealed.md — read only, wherever it sits: a denied file inside a writable folder
 *   Sales/outbox/nested/, Sales/moved/nested/ — read only: a denial at only the old, or only the new, path of a moved folder
 */
describe('preflight for moves and deletes', () => {
  const PROTECTED = 'target-company-state';
  const KB = (p: string) => `${KB_DIR}/${p}`;

  const verbsFor = (rel: string) => {
    if (rel.startsWith('Sales/outbox/nested/') || rel.startsWith('Sales/moved/nested/')) {
      return { read: true, write: false, download: false, owner: false };
    }
    if (rel.endsWith('/sealed.md')) return { read: true, write: false, download: false, owner: false };
    if (rel.startsWith('HR/')) return { read: true, write: true, download: false, owner: false };
    if (rel.startsWith('Locked/')) return { read: true, write: false, download: false, owner: false };
    if (rel.startsWith('Secret/')) return { read: false, write: false, download: false, owner: false };
    return { read: true, write: true, download: true, owner: true };
  };
  const rules = {
    canRead: async (_w: string, _u: string, rel: string) => verbsFor(rel).read,
    canReadBatch: async (_w: string, _u: string, paths: string[]) => new Map(paths.map((p) => [p, verbsFor(p).read])),
    canWrite: async (_w: string, _u: string, rel: string) => verbsFor(rel).write,
    canDownload: async (_w: string, _u: string, rel: string) => verbsFor(rel).download,
    canOwner: async (_w: string, _u: string, rel: string) => verbsFor(rel).owner,
    canWriteBatchAtRef: async (_w: string, _r: string, _u: string, rels: string[]) =>
      new Map(rels.map((p) => [p, verbsFor(p).write])),
    eligibleWritersAtRef: async () => ({ roles: ['Admin'], users: [] }),
  } as unknown as IAccessControl;

  const call = async (base: string, tool: string, body: Record<string, unknown>) => {
    const res = await post(`${base}/api/agent/tools/${tool}`, { branch: PROTECTED, ...body });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a tool body is free-form JSON, probed field by field
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  const exists = async (p: string) => fs.exists(p);

  async function seeded(): Promise<string> {
    const base = await start('write', rules);
    await fs.writeFile(KB('access.md'), '---\nread: everyone\n---\n');
    await fs.writeFile(KB('KnowledgeBase/Team/a.md'), 'a');
    await fs.writeFile(KB('Sales/deal.md'), 'deal');
    await fs.writeFile(KB('Sales/archive/nested/old.md'), 'old');
    await fs.writeFile(KB('Sales/archive/nested/older.md'), 'older');
    await fs.writeFile(KB('Sales/archive/top.md'), 'top');
    await fs.writeFile(KB('HR/policy.md'), 'policy');
    await fs.writeFile(KB('Locked/rules.md'), 'rules');
    return base;
  }

  describe('file_stat', () => {
    it('a platform file is managed, not movable, not deletable', async () => {
      const base = await seeded();
      const { status, body } = await call(base, 'file_stat', { path: KB('access.md') });
      expect(status).toBe(200);
      expect(body).toMatchObject({ type: 'file', managed: true, movable: false, deletable: false });
      expect(body.access).toEqual({ read: true, write: true, download: true, owner: true });
      expect(body.descendants).toBeUndefined();
    });

    it('a plain file is movable and deletable, with the caller\'s verdicts', async () => {
      const base = await seeded();
      expect((await call(base, 'file_stat', { path: KB('Sales/deal.md') })).body).toMatchObject({
        type: 'file', managed: false, movable: true, deletable: true,
        access: { read: true, write: true, download: true, owner: true },
      });
      expect((await call(base, 'file_stat', { path: KB('Locked/rules.md') })).body).toMatchObject({
        managed: false, movable: false, deletable: false,
        access: { read: true, write: false, download: false, owner: false },
      });
    });

    it('a folder counts its files at any depth; a reserved root folder is managed', async () => {
      const base = await seeded();
      expect((await call(base, 'file_stat', { path: KB('Sales/archive') })).body).toMatchObject({
        type: 'directory', managed: false, movable: true, deletable: true, descendants: 3,
      });
      expect((await call(base, 'file_stat', { path: KB('KnowledgeBase') })).body).toMatchObject({
        type: 'directory', managed: true, movable: false, deletable: false, descendants: 1,
      });
    });
  });

  describe('move_file', () => {
    it('a same-access move: the dry run changes nothing, the real call runs without confirm', async () => {
      const base = await seeded();
      const args = { src: KB('Sales/deal.md'), dest: KB('Sales/2026/deal.md') };
      const dry = await call(base, 'move_file', { ...args, dryRun: true });
      expect(dry.status).toBe(200);
      expect(dry.body).toMatchObject({
        ...args, kind: 'file', descendants: 1, accessChanges: false, allowed: true, dryRun: true, moved: false,
      });
      expect(dry.body.access.before).toEqual(dry.body.access.after);
      expect(dry.body.reason).toBeUndefined();
      expect(await exists(args.src)).toBe(true);
      expect(await exists(args.dest)).toBe(false);

      const run = await call(base, 'move_file', args);
      expect(run.body).toMatchObject({ moved: true });
      expect(await exists(args.dest)).toBe(true);
      expect(await exists(args.src)).toBe(false);
    });

    it('an access-changing move shows before/after and runs only with confirm: true', async () => {
      const base = await seeded();
      const args = { src: KB('Sales/deal.md'), dest: KB('HR/deal.md') };
      const dry = await call(base, 'move_file', { ...args, dryRun: true });
      expect(dry.body).toMatchObject({
        accessChanges: true,
        allowed: true,
        access: {
          before: { read: true, write: true, download: true, owner: true },
          after: { read: true, write: true, download: false, owner: false },
        },
      });

      const unconfirmed = await call(base, 'move_file', args);
      expect(unconfirmed.status).toBe(200);
      expect(unconfirmed.body).toMatchObject({ accessChanges: true, confirmationRequired: true, moved: false });
      expect(unconfirmed.body.message).toContain('confirm: true');
      expect(await exists(args.src)).toBe(true);
      expect(await exists(args.dest)).toBe(false);

      const confirmed = await call(base, 'move_file', { ...args, confirm: true });
      expect(confirmed.body).toMatchObject({ moved: true });
      expect(await exists(args.dest)).toBe(true);
    });

    it('a folder moves recursively', async () => {
      const base = await seeded();
      const args = { src: KB('Sales/archive'), dest: KB('Sales/old-archive') };
      expect((await call(base, 'move_file', { ...args, dryRun: true })).body).toMatchObject({ kind: 'folder', descendants: 3 });
      expect((await call(base, 'move_file', args)).body).toMatchObject({ moved: true });
      expect(await exists(KB('Sales/old-archive/nested/old.md'))).toBe(true);
      expect(await exists(args.src)).toBe(false);
    });

    it('a move the caller may not write: the dry run says so, the real call is a write-denied with proposal steps', async () => {
      const base = await seeded();
      const args = { src: KB('Sales/deal.md'), dest: KB('Locked/deal.md') };
      const dry = await call(base, 'move_file', { ...args, dryRun: true });
      expect(dry.body).toMatchObject({ allowed: false });
      expect(dry.body.reason).toContain(KB('Locked/deal.md'));

      const run = await call(base, 'move_file', args);
      expect(run.status).toBe(403);
      expect(run.body).toMatchObject({ code: 'write-denied', path: KB('Locked/deal.md'), canPropose: true });
      expect(run.body.reason).toContain('Eligible: Admin');
      expect(run.body.error).toBe(run.body.reason);
      expect(run.body.proposal.targetBranch).toBe(PROTECTED);
      expect(run.body.proposal.steps.join('\n')).toMatch(/create_branch[\s\S]*move_file[\s\S]*open_change_request/);
      expect(await exists(args.src)).toBe(true);
    });

    it('a folder move judges every file under it: one denied file blocks the move, in the dry run and for real', async () => {
      const base = await seeded();
      await fs.writeFile(KB('Sales/archive/nested/sealed.md'), 'sealed');
      const args = { src: KB('Sales/archive'), dest: KB('Sales/archive-2026') };
      const dry = await call(base, 'move_file', { ...args, dryRun: true });
      expect(dry.body).toMatchObject({ kind: 'folder', descendants: 4, accessChanges: false, allowed: false });
      expect(dry.body.reason).toContain('sealed.md');
      const run = await call(base, 'move_file', { ...args, confirm: true });
      expect(run.status).toBe(403);
      expect(run.body).toMatchObject({ code: 'write-denied', path: KB('Sales/archive/nested/sealed.md'), canPropose: true });
      expect(await exists(KB('Sales/archive/nested/sealed.md'))).toBe(true);
      expect(await exists(args.dest)).toBe(false);
    });

    it('file_stat on a folder answers exactly what the move and delete dry runs answer, a denied file inside included', async () => {
      const base = await seeded();
      const path = KB('Sales/archive');
      const verdicts = async () => ({
        stat: (await call(base, 'file_stat', { path })).body,
        move: (await call(base, 'move_file', { src: path, dest: KB('Sales/archive-2026'), dryRun: true })).body,
        del: (await call(base, 'delete_folder', { path, dryRun: true })).body,
      });
      // All writable: every answer says yes.
      let v = await verdicts();
      expect([v.stat.movable, v.move.allowed, v.stat.deletable, v.del.allowed]).toEqual([true, true, true, true]);
      // One file its own rules deny, deep inside the writable folder: every answer says no.
      await fs.writeFile(KB('Sales/archive/nested/sealed.md'), 'sealed');
      v = await verdicts();
      expect(v.stat).toMatchObject({ access: { write: true }, descendants: 4 });
      expect(v.stat.movable).toBe(v.move.allowed);
      expect(v.stat.deletable).toBe(v.del.allowed);
      expect([v.stat.movable, v.stat.deletable]).toEqual([false, false]);
    });

    it('a folder move judges each file at its old path and at its new path, separately', async () => {
      const base = await seeded();
      // Denied only at the old path: the file under Sales/outbox/nested/ may not be removed.
      await fs.writeFile(KB('Sales/outbox/nested/letter.md'), 'letter');
      const oldSide = await call(base, 'move_file', { src: KB('Sales/outbox'), dest: KB('Sales/sent'), dryRun: true });
      expect(oldSide.body).toMatchObject({ allowed: false });
      expect(oldSide.body.reason).toContain(KB('Sales/outbox/nested/letter.md'));
      // Denied only at the new path: Sales/archive is writable, Sales/moved/nested/ is not.
      const newSide = await call(base, 'move_file', { src: KB('Sales/archive'), dest: KB('Sales/moved'), dryRun: true });
      expect(newSide.body).toMatchObject({ allowed: false });
      expect(newSide.body.reason).toContain(KB('Sales/moved/nested/'));
      const run = await call(base, 'move_file', { src: KB('Sales/archive'), dest: KB('Sales/moved'), confirm: true });
      expect(run.status).toBe(403);
      expect(run.body).toMatchObject({ code: 'write-denied' });
      expect(await exists(KB('Sales/archive/nested/old.md'))).toBe(true);
    });

    it('trailing slashes do not change which paths a folder move is judged on', async () => {
      const base = await seeded();
      const args = { src: `${KB('Sales/archive')}/`, dest: `${KB('Sales/moved')}/` };
      const dry = await call(base, 'move_file', { ...args, dryRun: true });
      expect(dry.body).toMatchObject({ src: KB('Sales/archive'), dest: KB('Sales/moved'), descendants: 3, allowed: false });
      expect(dry.body.reason).toContain(KB('Sales/moved/nested/'));
      expect((await call(base, 'move_file', { ...args, confirm: true })).status).toBe(403);
      expect(await exists(KB('Sales/archive/nested/old.md'))).toBe(true);
      expect(await exists(KB('Sales/moved'))).toBe(false);
    });

    it('a denied move into a path the caller cannot read cannot be proposed, and says why', async () => {
      const base = await seeded();
      const run = await call(base, 'move_file', { src: KB('Sales/deal.md'), dest: KB('Secret/deal.md'), confirm: true });
      expect(run.status).toBe(403);
      expect(run.body).toMatchObject({ code: 'write-denied', canPropose: false });
      expect(run.body.proposal).toBeUndefined();
      expect(run.body.whyNot).toContain("can't read");
    });

    it('a draft branch is not write-gated, so the same move is allowed there', async () => {
      const base = await seeded();
      const dry = await call(base, 'move_file', { branch: 'someone/draft', src: KB('Sales/deal.md'), dest: KB('Locked/deal.md'), dryRun: true });
      expect(dry.body).toMatchObject({ allowed: true, accessChanges: true });
    });

    it('a platform file is refused with the platform-file sentence, in the dry run and for real', async () => {
      const base = await seeded();
      const args = { src: KB('access.md'), dest: KB('Sales/access.md') };
      const sentence = 'access.md is a platform file and stays in its folder.';
      expect((await call(base, 'move_file', { ...args, dryRun: true })).body).toMatchObject({ allowed: false, reason: sentence });
      const run = await call(base, 'move_file', { ...args, confirm: true });
      expect(run.status).toBe(400);
      expect(run.body.error).toBe(sentence);
      expect(await exists(args.src)).toBe(true);
    });

    it('an existing destination is refused, never overwritten', async () => {
      const base = await seeded();
      const args = { src: KB('Sales/deal.md'), dest: KB('Sales/archive/top.md') };
      expect((await call(base, 'move_file', { ...args, dryRun: true })).body).toMatchObject({ allowed: false });
      expect((await call(base, 'move_file', args)).status).toBe(409);
      expect(await fs.readFile(args.dest, { encoding: 'utf-8' })).toBe('top');
    });
  });

  describe('delete_folder', () => {
    it('the dry run lists the files and deletes nothing; without confirm nothing is deleted; with confirm the folder is gone', async () => {
      const base = await seeded();
      const path = KB('Sales/archive');
      const dry = await call(base, 'delete_folder', { path, dryRun: true });
      expect(dry.status).toBe(200);
      expect(dry.body).toMatchObject({ path, kind: 'folder', descendants: 3, allowed: true, dryRun: true, filesTruncated: false });
      expect([...dry.body.files].sort()).toEqual([
        KB('Sales/archive/nested/old.md'), KB('Sales/archive/nested/older.md'), KB('Sales/archive/top.md'),
      ]);
      expect(await exists(KB('Sales/archive/top.md'))).toBe(true);

      const unconfirmed = await call(base, 'delete_folder', { path });
      expect(unconfirmed.body).toMatchObject({ confirmationRequired: true, deleted: false });
      expect(unconfirmed.body.message).toContain('confirm: true');
      expect(await exists(KB('Sales/archive/nested/old.md'))).toBe(true);

      const confirmed = await call(base, 'delete_folder', { path, confirm: true });
      expect(confirmed.body).toMatchObject({ deleted: true, descendants: 3 });
      expect(await exists(path)).toBe(false);
      const listing = await call(base, 'list_files', { path: KB('Sales') });
      expect(listing.body.entries.map((e: { name: string }) => e.name)).toEqual(['deal.md']);
    });

    it('a platform folder is refused with its reason', async () => {
      const base = await seeded();
      const dry = await call(base, 'delete_folder', { path: KB('KnowledgeBase'), dryRun: true });
      expect(dry.body).toMatchObject({ allowed: false, reason: 'KnowledgeBase/ is a platform folder and cannot be moved or deleted.' });
      const run = await call(base, 'delete_folder', { path: KB('KnowledgeBase'), confirm: true });
      expect(run.status).toBe(400);
      expect(await exists(KB('KnowledgeBase/Team/a.md'))).toBe(true);
    });

    it('a folder the caller cannot write is refused with the structured denial', async () => {
      const base = await seeded();
      expect((await call(base, 'delete_folder', { path: KB('Locked'), dryRun: true })).body).toMatchObject({ allowed: false });
      const run = await call(base, 'delete_folder', { path: KB('Locked'), confirm: true });
      expect(run.status).toBe(403);
      expect(run.body).toMatchObject({ code: 'write-denied', canPropose: true });
      expect(await exists(KB('Locked/rules.md'))).toBe(true);
    });

    it('an empty folder is deleted without confirm; a file is pointed to delete_file', async () => {
      const base = await seeded();
      await fs.mkdir(KB('Sales/empty'), { recursive: true });
      expect((await call(base, 'delete_folder', { path: KB('Sales/empty') })).body).toMatchObject({ deleted: true, descendants: 0 });
      expect(await exists(KB('Sales/empty'))).toBe(false);
      const file = await call(base, 'delete_folder', { path: KB('Sales/deal.md') });
      expect(file.status).toBe(400);
      expect(file.body.error).toContain('delete_file');
    });
  });

  describe('delete_file', () => {
    it('on a folder answers with delete_folder instead of the filesystem error', async () => {
      const base = await seeded();
      const run = await call(base, 'delete_file', { path: KB('Sales/archive') });
      expect(run.status).toBe(400);
      expect(run.body.error).toContain('use delete_folder');
      expect(await exists(KB('Sales/archive/top.md'))).toBe(true);
    });

    it('a denied delete is the structured denial', async () => {
      const base = await seeded();
      const run = await call(base, 'delete_file', { path: KB('Locked/rules.md') });
      expect(run.status).toBe(403);
      expect(run.body).toMatchObject({ code: 'write-denied', path: KB('Locked/rules.md'), canPropose: true });
      expect(run.body.proposal.steps.join('\n')).toContain('delete_file');
    });
    it('a refusal from the lock gate itself (rules changed after the preflight) is the structured denial too', async () => {
      const base = await seeded();
      fs.deleteFile = async (p: string) => {
        throw new AccessDeniedError({ path: p, eligibleRoles: ['Admin'], eligibleUsers: [] });
      };
      const run = await call(base, 'delete_file', { path: KB('Sales/deal.md') });
      expect(run.status).toBe(403);
      expect(run.body).toMatchObject({ code: 'write-denied', path: KB('Sales/deal.md'), canPropose: true });
    });
  });

  describe('what counts as the platform\'s own, and what a move or delete may reach', () => {
    const caseSensitiveDisk = process.platform === 'linux';

    it('roles.yaml and AGENTS.md are platform files only at the root; access.md and .bevelignore at any depth', async () => {
      const base = await seeded();
      await fs.writeFile(KB('roles.yaml'), 'roles: {}\n');
      await fs.writeFile(KB('Sales/roles.yaml'), 'content');
      await fs.writeFile(KB('Sales/AGENTS.md'), 'content');
      await fs.writeFile(KB('Sales/.bevelignore'), '*.tmp\n');
      const managed = async (p: string) => (await call(base, 'file_stat', { path: KB(p) })).body.managed;
      expect(await managed('roles.yaml')).toBe(true);
      expect(await managed('Sales/roles.yaml')).toBe(false);
      expect(await managed('Sales/AGENTS.md')).toBe(false);
      expect(await managed('Sales/.bevelignore')).toBe(true);
      expect((await call(base, 'move_file', { src: KB('Sales/roles.yaml'), dest: KB('Sales/old-roles.yaml') })).body).toMatchObject({ moved: true });
    });

    it.skipIf(!caseSensitiveDisk)('a differently cased access.md is content on a case-sensitive disk', async () => {
      const base = await seeded();
      await fs.writeFile(KB('Sales/Access.md'), 'notes');
      expect((await call(base, 'file_stat', { path: KB('Sales/Access.md') })).body).toMatchObject({ managed: false, movable: true });
    });

    it('git metadata is refused, and a folder walk never enters it', async () => {
      const base = await seeded();
      await fs.writeFile(KB('.git/HEAD'), 'ref: refs/heads/main\n');
      await fs.writeFile(KB('Sales/sub/.git/HEAD'), 'ref: refs/heads/main\n');
      const dry = await call(base, 'delete_folder', { path: KB('.git'), dryRun: true });
      expect(dry.body).toMatchObject({ allowed: false });
      expect(dry.body.reason).toContain('git metadata');
      expect((await call(base, 'delete_folder', { path: KB('.git'), confirm: true })).status).toBe(400);
      expect((await call(base, 'delete_file', { path: KB('.git/HEAD') })).status).toBe(400);
      expect((await call(base, 'move_file', { src: KB('.git'), dest: KB('Sales/git') })).status).toBe(400);
      expect(await exists(KB('.git/HEAD'))).toBe(true);
      expect((await call(base, 'file_stat', { path: KB('Sales/sub') })).body).toMatchObject({ descendants: 0 });
    });

    it('a folder\'s own access.md goes with it, deleted after every other file', async () => {
      const base = await seeded();
      await fs.writeFile(KB('Sales/archive/access.md'), '---\nread: everyone\n---\n');
      const order: string[] = [];
      const deleteFile = fs.deleteFile.bind(fs);
      fs.deleteFile = async (p: string, o?: never) => {
        order.push(p);
        return deleteFile(p, o);
      };
      const run = await call(base, 'delete_folder', { path: KB('Sales/archive'), confirm: true });
      expect(run.body).toMatchObject({ deleted: true, descendants: 4 });
      expect(order).toHaveLength(4);
      expect(order.at(-1)).toBe(KB('Sales/archive/access.md'));
    });

    it('a restricted run is judged on the files a folder delete or move would write, not the folder path', async () => {
      const base = await seeded();
      writePolicy.restrictToExtensions('restricted-run', ['.html']);
      await fs.writeFile(KB('Sales/views/a.html'), '<p>a</p>');
      await fs.writeFile(KB('Sales/views/b.html'), '<p>b</p>');
      const moved = await call(base, 'move_file', { src: KB('Sales/views'), dest: KB('Sales/dashboards'), sessionId: 'restricted-run' });
      expect(moved.body).toMatchObject({ moved: true, descendants: 2 });
      const deleted = await call(base, 'delete_folder', { path: KB('Sales/dashboards'), confirm: true, sessionId: 'restricted-run' });
      expect(deleted.body).toMatchObject({ deleted: true });
      const refused = await call(base, 'delete_folder', { path: KB('Sales/archive'), confirm: true, sessionId: 'restricted-run' });
      expect(refused.status).toBe(403);
      expect(await exists(KB('Sales/archive/top.md'))).toBe(true);
    });

    it.skipIf(process.platform === 'win32')('a move or folder delete through a symbolic link that leaves the repository is refused, a dangling one included', async () => {
      const base = await seeded();
      await mkdir(join(tempDir, 'beside-the-clone'), { recursive: true });
      await symlink(join(tempDir, 'beside-the-clone'), join(tempDir, KB('Sales/out')));
      const escaped = await call(base, 'move_file', { src: KB('Sales/deal.md'), dest: KB('Sales/out/deal.md'), dryRun: true });
      expect(escaped.status).toBe(400);
      expect(escaped.body.error).toContain('symbolic link');
      expect((await call(base, 'delete_folder', { path: KB('Sales/out'), dryRun: true })).status).toBe(400);
      await symlink(join(tempDir, 'nowhere'), join(tempDir, KB('Sales/dangling.md')));
      const collided = await call(base, 'move_file', { src: KB('Sales/deal.md'), dest: KB('Sales/dangling.md') });
      expect(collided.status).toBe(400);
      expect(collided.body.error).toContain('symbolic link');
      expect(await exists(KB('Sales/deal.md'))).toBe(true);
    });

    it('a path with "." or ".." segments is refused by every move and delete, before anything changes', async () => {
      const base = await seeded();
      const sneaky = KB('Sales/../Locked/rules.md');
      const del = await call(base, 'delete_file', { path: sneaky });
      expect(del.status).toBe(400);
      expect(del.body.error).toContain('".." segments');
      expect((await call(base, 'move_file', { src: sneaky, dest: KB('Sales/rules.md'), dryRun: true })).status).toBe(400);
      expect((await call(base, 'move_file', { src: KB('Sales/deal.md'), dest: KB('Sales/../Locked/deal.md') })).status).toBe(400);
      expect((await call(base, 'delete_folder', { path: KB('Sales/../Locked'), confirm: true })).status).toBe(400);
      expect((await call(base, 'file_stat', { path: KB('Sales/./deal.md') })).body).toMatchObject({ movable: false, deletable: false });
      expect(await exists(KB('Locked/rules.md'))).toBe(true);
      expect(await exists(KB('Sales/deal.md'))).toBe(true);
    });

    it.skipIf(process.platform === 'win32')('file_stat agrees with move and delete about links on the way, a dangling one included', async () => {
      const base = await seeded();
      await symlink(join(tempDir, KB('Locked')), join(tempDir, KB('Sales/alias')));
      expect((await call(base, 'file_stat', { path: KB('Sales/alias/rules.md') })).body).toMatchObject({ movable: false, deletable: false });
      await symlink(join(tempDir, 'nowhere'), join(tempDir, KB('Sales/gone')));
      const dangling = await call(base, 'file_stat', { path: KB('Sales/gone/x.md') });
      expect(dangling.status).toBe(400);
      expect(dangling.body.error).toContain(`the symbolic link "${KB('Sales/gone')}"`);
    });

    it.skipIf(process.platform === 'win32')('a link past the descendants cap still makes a folder not deletable', async () => {
      const base = await seeded();
      const dir = join(tempDir, KB('Sales/bulk'));
      await mkdir(join(dir, 'a'), { recursive: true });
      const names = Array.from({ length: 10_001 }, (_, i) => `f${i}.md`);
      for (let i = 0; i < names.length; i += 500) {
        await Promise.all(names.slice(i, i + 500).map((n) => writeFile(join(dir, 'a', n), '')));
      }
      await mkdir(join(dir, 'z'), { recursive: true });
      await symlink(join(tempDir, 'nowhere'), join(dir, 'z', 'link'));
      const stat = await call(base, 'file_stat', { path: KB('Sales/bulk') });
      expect(stat.body).toMatchObject({ descendants: 10_000, descendantsTruncated: true, deletable: false });
      expect((await call(base, 'delete_folder', { path: KB('Sales/bulk'), dryRun: true })).body).toMatchObject({ allowed: false });
    }, 60_000);

    it.skipIf(process.platform === 'win32')('a link inside the repository is not followed either, so a move cannot write into a folder whose rules it never judged', async () => {
      const base = await seeded();
      await symlink(join(tempDir, KB('Locked')), join(tempDir, KB('Sales/alias')));
      const run = await call(base, 'move_file', { src: KB('Sales/deal.md'), dest: KB('Sales/alias/deal.md'), dryRun: true });
      expect(run.status).toBe(400);
      expect(run.body.error).toContain(`the symbolic link "${KB('Sales/alias')}"`);
      expect((await call(base, 'move_file', { src: KB('Sales/deal.md'), dest: KB('Sales/alias/deal.md') })).status).toBe(400);
      expect((await call(base, 'delete_file', { path: KB('Sales/alias/rules.md') })).status).toBe(400);
      expect(await exists(KB('Locked/rules.md'))).toBe(true);
      expect(await exists(KB('Locked/deal.md'))).toBe(false);
    });

    it.skipIf(process.platform === 'win32')('a folder holding a symbolic link is refused in the dry run and deletes nothing, instead of half-deleting', async () => {
      const base = await seeded();
      // The Local Testing shape: a file sorted before the link, the link (to a
      // folder, so the per-file delete cannot remove it), a file after it.
      await fs.writeFile(KB('Sales/links/aaa.md'), 'a');
      await fs.writeFile(KB('Sales/links/real.md'), 'r');
      await symlink('../archive', join(tempDir, KB('Sales/links/inside')));
      const dry = await call(base, 'delete_folder', { path: KB('Sales/links'), dryRun: true });
      expect(dry.status).toBe(200);
      expect(dry.body).toMatchObject({ allowed: false });
      expect(dry.body.reason).toContain(`"${KB('Sales/links/inside')}"`);
      const run = await call(base, 'delete_folder', { path: KB('Sales/links'), confirm: true });
      expect(run.status).toBe(400);
      expect(run.body.error).toBe(dry.body.reason);
      for (const p of ['Sales/links/aaa.md', 'Sales/links/real.md', 'Sales/archive/top.md']) {
        expect(await exists(KB(p)), p).toBe(true);
      }
      expect((await call(base, 'file_stat', { path: KB('Sales/links') })).body).toMatchObject({ deletable: false });
    });

    it.skipIf(process.platform === 'win32')('a link itself is answered as a link by delete_file, move_file and file_stat, not "not found"', async () => {
      const base = await seeded();
      await symlink(join(tempDir, 'nowhere'), join(tempDir, KB('Sales/dangling.md')));
      await symlink('deal.md', join(tempDir, KB('Sales/alias.md')));
      for (const path of [KB('Sales/dangling.md'), KB('Sales/alias.md')]) {
        const del = await call(base, 'delete_file', { path });
        expect(del.status, path).toBe(400);
        expect(del.body.error, path).toBe(`"${path}" is a symbolic link; the agent tools never follow or remove links.`);
        const mv = await call(base, 'move_file', { src: path, dest: KB('Sales/moved.md'), dryRun: true });
        expect(mv.status, path).toBe(400);
        expect(mv.body.error, path).toContain('symbolic link');
      }
      expect((await call(base, 'file_stat', { path: KB('Sales/alias.md') })).body).toMatchObject({ movable: false, deletable: false });
      expect(await exists(KB('Sales/deal.md'))).toBe(true);
    });

    it('a move cannot create a platform file or folder at the destination', async () => {
      const base = await seeded();
      const dry = await call(base, 'move_file', { src: KB('Sales/deal.md'), dest: KB('Sales/archive/access.md'), dryRun: true });
      expect(dry.body).toMatchObject({ allowed: false, reason: 'access.md is a platform file name; a move cannot create a platform file.' });
      expect((await call(base, 'move_file', { src: KB('Sales/deal.md'), dest: KB('Sales/archive/access.md') })).status).toBe(400);
      expect((await call(base, 'move_file', { src: KB('Sales/archive'), dest: KB('Skills'), dryRun: true })).body).toMatchObject({ allowed: false });
      expect(await exists(KB('Sales/deal.md'))).toBe(true);
      expect(await exists(KB('Sales/archive/access.md'))).toBe(false);
    });

    it.skipIf(process.platform !== 'linux')('on a case-sensitive disk a case-distinct destination is a collision, not an overwrite', async () => {
      const base = await seeded();
      await fs.writeFile(KB('Sales/Deal.md'), 'other deal');
      const run = await call(base, 'move_file', { src: KB('Sales/deal.md'), dest: KB('Sales/Deal.md') });
      expect(run.status).toBe(409);
      expect(await fs.readFile(KB('Sales/Deal.md'), { encoding: 'utf-8' })).toBe('other deal');
      expect(await exists(KB('Sales/deal.md'))).toBe(true);
    });
  });

  describe('descriptions match behaviour', () => {
    type Schema = { properties?: Record<string, Schema> };
    const def = async (name: string) => {
      const d = (await toolRegistry.listInternal()).find((t) => t.name === name);
      expect(d, name).toBeDefined();
      return d as unknown as { description: string; inputs: Schema; outputs: Schema };
    };
    const declaredOutputs = (d: { outputs: Schema }) => Object.keys(d.outputs.properties ?? {});

    it('move_file states folders, recursion, collisions, platform files and the confirm rule, and declares every field it returns', async () => {
      const base = await seeded();
      const d = await def('move_file');
      expect(d.description).toMatch(/FILE or FOLDER/);
      expect(d.description).toMatch(/folder moves recursively/);
      expect(d.description).toMatch(/destination must not exist/);
      expect(d.description).toContain('is a platform file and stays in its folder.');
      expect(d.description).toContain('`dryRun: true`');
      expect(d.description).toContain('`confirm: true`');
      expect(Object.keys(d.inputs.properties.body.properties)).toEqual(expect.arrayContaining(['dryRun', 'confirm']));
      // What the description promises a dry run returns is what it returns.
      const dry = await call(base, 'move_file', { src: KB('Sales/deal.md'), dest: KB('HR/deal.md'), dryRun: true });
      for (const key of ['src', 'dest', 'kind', 'descendants', 'access', 'accessChanges', 'allowed']) {
        expect(d.description, key).toContain(key);
        expect(dry.body, key).toHaveProperty(key);
      }
      const unconfirmed = await call(base, 'move_file', { src: KB('Sales/deal.md'), dest: KB('HR/deal.md') });
      expect(d.description).toContain('confirmationRequired: true');
      expect(unconfirmed.body.confirmationRequired).toBe(true);
      for (const body of [dry.body, unconfirmed.body]) {
        expect(declaredOutputs(d)).toEqual(expect.arrayContaining(Object.keys(body)));
      }
    });

    it('delete_folder states the confirm rule and refusals, and declares every field it returns', async () => {
      const base = await seeded();
      const d = await def('delete_folder');
      expect(d.description).toContain('`dryRun: true`');
      expect(d.description).toContain('A non-empty folder is deleted only with `confirm: true`');
      expect(d.description).toContain('platform folder');
      const dry = await call(base, 'delete_folder', { path: KB('Sales/archive'), dryRun: true });
      const unconfirmed = await call(base, 'delete_folder', { path: KB('Sales/archive') });
      const confirmed = await call(base, 'delete_folder', { path: KB('Sales/archive'), confirm: true });
      for (const body of [dry.body, unconfirmed.body, confirmed.body]) {
        expect(declaredOutputs(d)).toEqual(expect.arrayContaining(Object.keys(body)));
      }
    });

    it('delete_file names delete_folder, file_stat names its new fields, and every destructive tool names the proposal route', async () => {
      const base = await seeded();
      expect((await def('delete_file')).description).toContain('`delete_folder`');
      const stat = await def('file_stat');
      const body = (await call(base, 'file_stat', { path: KB('Sales/archive') })).body;
      for (const key of ['managed', 'movable', 'deletable', 'access', 'descendants']) {
        expect(stat.description, key).toContain(`\`${key}`);
        expect(body, key).toHaveProperty(key);
      }
      for (const name of ['move_file', 'delete_file', 'delete_folder']) {
        expect((await def(name)).description, name).toContain('`write-denied`');
      }
    });
  });
});
