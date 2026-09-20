import type { Server as HttpServer } from 'node:http';
import { execFile } from 'node:child_process';
import { link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import AdmZip from 'adm-zip';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalFilesystem } from '@mastra/core/workspace';
import { ToolRegistry } from '../../tool-registry/tool-registry.js';
import { createToolHandlerFactory } from '../../tool-helpers/tool-handler.js';
import type { ToolContext } from '../../tool-helpers/tool.contract.js';
import type { ToolAuth } from '../../tool-auth/tool-auth.middleware.js';
import { CONTENT_RULE, registerWorkspaceTools } from '../workspace.tools.js';
import { RoutineWritePolicyService } from '../routine-write-policy.js';
import { UuidSessionSink, type ISessionSink } from '../session-sink.js';
import { WorkflowHooks } from '../../workflow/workflow-hooks.js';
import { SpillStore } from '../spill-store.js';
import { DocExtractService } from '../file-readers/doc-extract.service.js';
import { OCTET_STREAM_FALLBACK_NOTE } from '../file-readers/content-mode.js';
import type { IAccessControl } from '../../access/access-control.interface.js';
import { isBranchAuthoredBy, isOwnSuggestionsBranch } from '@bevel-software/platform-shared';
import { assertValidBranchName } from '../../kb-fs/branch-name.js';
import { GIT_INTERNALS_MESSAGE, PathNotFoundError } from '../../../shared/domain-errors.js';
import { AccessDeniedError } from '../../access-model/access-errors.js';
import { PROPOSAL_ROUTE_NOTE, proposalTitleFor } from '../write-denial.js';
import { NOT_FOUND_NEXT_STEP } from '../not-found.js';

const KB_DIR = 'knowledge-base';

/** Allow-all access control — the default for tests not exercising read gating. */
const allowAll = {
  canRead: async () => true,
  canReadBatch: async (_w: string, _u: string, paths: string[]) =>
    new Map(paths.map((p) => [p, true])),
  // The verbs `file_stat` and the move/delete preflight ask about. Allowing
  // everything, and answering "no rules at HEAD" for the batch write check,
  // keeps these tests about what they test rather than about access.
  canWrite: async () => true,
  canDownload: async () => true,
  canOwner: async () => true,
  canWriteBatchAtRef: async () => null,
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
/** Every folder turn a tool took, as `workspaceId:dir`. */
let folderTurns: string[] = [];
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
/**
 * Another writer getting to a path in the window the real `LockingFilesystem`
 * closes: the stand-ins below run it where that filesystem would be acquiring
 * the lock — after the tool's preflight, before the under-lock `check`. Fires
 * ONCE (it clears itself), so a test's later writes are ordinary ones.
 */
let raceHook: (() => Promise<void>) | null = null;

async function start(
  scope: 'read' | 'write' = 'write',
  access: IAccessControl = allowAll,
  /** The signed-in caller's address — only the branch-naming tests vary it. */
  userEmail = 'e@x',
): Promise<string> {
  raceHook = null;
  tempDir = await mkdtemp(join(tmpdir(), 'ws-tools-'));
  docCacheDir = await mkdtemp(join(tmpdir(), 'ws-doc-cache-'));
  fs = new LocalFilesystem({ basePath: tempDir, contained: true });
  // `LockingFilesystem.writeFiles` is what the real `delete_folder` and
  // `write_files` land through — one lock cycle over every path, then one
  // commit. A plain LocalFilesystem has no such method, so stand in for its
  // DISK effect and let the tools be exercised end to end. This stand-in is
  // NOT atomic, and these tests do not claim atomicity: they assert what the
  // TOOL controls — that it hands the whole folder over in ONE batch. The
  // batch's own all-or-none behaviour is asserted where it lives, in
  // `locking-filesystem.test.ts` ("a DELETE batch whose later lock is
  // contended deletes nothing").
  // Both stand-ins honour the caller's under-lock `check` the way the real
  // filesystem does — run it with the paths "locked" (here: just before any
  // byte lands), let a refusal through untouched, and in the batch case write
  // only what the check keeps. That is what makes the outcome the tools report
  // a verdict about the state they actually wrote over.
  const runRaceHook = async (): Promise<void> => {
    const hook = raceHook;
    raceHook = null;
    if (hook) await hook();
  };
  const plainWriteFile = fs.writeFile.bind(fs);
  (fs as unknown as Record<string, unknown>).writeFile = async (
    path: string,
    content: string,
    options?: unknown,
    check?: () => Promise<void>,
  ) => {
    await runRaceHook();
    await check?.();
    return plainWriteFile(path, content, options as never);
  };
  (fs as unknown as Record<string, unknown>).writeFiles = async (
    writes: { path: string; content: string }[],
    _summary: string,
    deletes: string[] = [],
    check?: (
      pending: readonly { path: string; content: string }[],
    ) => Promise<{ path: string; content: string }[]>,
  ) => {
    await runRaceHook();
    const landing = check ? await check(writes) : writes;
    for (const w of landing) await plainWriteFile(w.path, w.content);
    for (const p of deletes) await fs.deleteFile(p);
  };
  await fs.writeFile('a.md', 'hello\nworld\n');
  workspacePathCalls = [];
  folderTurns = [];
  writePolicy = new RoutineWritePolicyService();
  focusedBranch = undefined;

  const registry = new ToolRegistry();
  toolRegistry = registry;
  const resolve = async (auth: ToolAuth, signal: AbortSignal, sessionId?: string): Promise<ToolContext> => ({
    user: { id: 'u', email: userEmail, name: 'N' },
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
      withFolderTurn: async <T>(id: string, dir: string, op: () => Promise<T>) => {
        folderTurns.push(`${id}:${dir}`);
        return op();
      },
      // Enough of `unzipFile` to exercise the TOOL: the one answer the tool
      // shapes is absence, and the real service raises exactly this error for
      // it (asserted in workspace.service.test.ts). Extraction itself lives
      // there too — none of it is the tool's to decide.
      unzipFile: async (_id: string, zipRel: string) => {
        try {
          await stat(join(tempDir, zipRel));
        } catch {
          throw new PathNotFoundError(zipRel);
        }
        return { destination: '', extracted: [], skipped: [] };
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

  // Copy path gives the root-anchored `/<kbDirName>/…`, and people paste
  // that same text into an agent: a leading slash names the same path.
  it('every path input accepts a leading slash as the same workspace path', async () => {
    const base = await start();
    expect(await (await post(`${base}/api/agent/tools/read_file`, { path: '/a.md' })).json()).toEqual({ path: 'a.md', content: 'hello\nworld\n' });
    expect(await (await post(`${base}/api/agent/tools/file_stat`, { path: '/a.md' })).json()).toMatchObject({ type: 'file' });
    await post(`${base}/api/agent/tools/write_file`, { path: '/b.md', content: 'fresh' });
    await post(`${base}/api/agent/tools/write_file`, { path: '/c.md', content: 'batch' });
    await post(`${base}/api/agent/tools/edit_file`, { path: '/a.md', old_string: 'world', new_string: 'earth' });
    await post(`${base}/api/agent/tools/mkdir`, { path: '/dir' });
    await post(`${base}/api/agent/tools/copy_file`, { src: '/b.md', dest: '/dir/b-copy.md' });
    await post(`${base}/api/agent/tools/move_file`, { src: '/c.md', dest: '/dir/c.md' });
    expect(await readFile(join(tempDir, 'a.md'), 'utf8')).toBe('hello\nearth\n');
    expect(await readFile(join(tempDir, 'b.md'), 'utf8')).toBe('fresh');
    expect(await readFile(join(tempDir, 'dir', 'b-copy.md'), 'utf8')).toBe('fresh');
    expect(await readFile(join(tempDir, 'dir', 'c.md'), 'utf8')).toBe('batch');
    const list = (await (await post(`${base}/api/agent/tools/list_files`, { path: '/dir' })).json()) as { path: string; entries: { name: string }[] };
    expect(list.path).toBe('dir');
    expect(list.entries.map((e) => e.name).sort()).toEqual(['b-copy.md', 'c.md']);
    const grep = (await (await post(`${base}/api/agent/tools/grep`, { pattern: 'earth', path: '/a.md' })).json()) as { matches: { path: string }[] };
    expect(grep.matches).toContainEqual(expect.objectContaining({ path: 'a.md' }));
    await post(`${base}/api/agent/tools/delete_file`, { path: '/b.md' });
    await expect(readFile(join(tempDir, 'b.md'), 'utf8')).rejects.toThrow();
  });

  it('says so on the path inputs', async () => {
    await start();
    const tools = await toolRegistry.listInternal();
    for (const name of ['read_file', 'list_files', 'file_stat', 'grep', 'write_file', 'edit_file', 'delete_file', 'mkdir', 'unzip']) {
      const def = tools.find((t) => t.name === name)!;
      const body = (def.inputs as { properties: { body: { properties: Record<string, { description?: string }> } } }).properties.body;
      expect(body.properties.path.description, name).toContain('with or without a leading slash');
    }
    for (const name of ['copy_file', 'move_file']) {
      const def = tools.find((t) => t.name === name)!;
      const body = (def.inputs as { properties: { body: { properties: Record<string, { description?: string }> } } }).properties.body;
      expect(body.properties.src.description, name).toContain('with or without a leading slash');
      expect(body.properties.dest.description, name).toContain('with or without a leading slash');
    }
    const batch = tools.find((t) => t.name === 'write_files')!;
    const batchBody = (batch.inputs as { properties: { body: { properties: { files: { items: { properties: Record<string, { description?: string }> } } } } } }).properties.body;
    expect(batchBody.properties.files.items.properties.path.description).toContain('with or without a leading slash');
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

/**
 * `mode` on the two write tools. The default is `create`, so "write this
 * content here" can no longer replace a page the agent never read: an
 * existing path is refused, by name, with the one argument that would have
 * made it a deliberate replacement. `write_files` answers for EVERY requested
 * path, in the order it was given them, and a path it cannot write does not
 * stop the ones it can.
 */
describe('write modes and per-path outcomes', () => {
  const writeFile = (base: string, body: Record<string, unknown>) => post(`${base}/api/agent/tools/write_file`, body);
  const writeFiles = (base: string, body: Record<string, unknown>) => post(`${base}/api/agent/tools/write_files`, body);
  const onDisk = (p: string) => readFile(join(tempDir, p), 'utf8');
  interface BatchAnswer { count: number; files: { path: string; outcome: string; error?: string; message?: string }[] }

  it('write_file with no mode creates a new file and says `created`', async () => {
    const base = await start();
    const res = await writeFile(base, { path: 'fresh.md', content: 'new page' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ path: 'fresh.md', bytes: 8, outcome: 'created' });
    expect(await onDisk('fresh.md')).toBe('new page');
  });

  it('write_file with no mode refuses a path that exists, names it, says how to replace it, and leaves it alone', async () => {
    const base = await start();
    const res = await writeFile(base, { path: 'a.md', content: 'clobbered' });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; code: string; path: string };
    expect(body.code).toBe('exists');
    expect(body.path).toBe('a.md');
    expect(body.error).toContain('a.md');
    expect(body.error).toContain('pass mode: overwrite to replace it');
    expect(await onDisk('a.md')).toBe('hello\nworld\n');
  });

  it('write_file mode overwrite replaces and says `replaced`, and creates what is not there yet', async () => {
    const base = await start();
    const replaced = await writeFile(base, { path: 'a.md', content: 'replacement' });
    expect(replaced.status).toBe(409); // …without the mode.
    const res = await writeFile(base, { path: 'a.md', content: 'replacement', mode: 'overwrite' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ path: 'a.md', outcome: 'replaced' });
    expect(await onDisk('a.md')).toBe('replacement');
    // `overwrite` on a path with nothing at it is still a create, and says so.
    const created = await writeFile(base, { path: 'not-there.md', content: 'x', mode: 'overwrite' });
    expect(await created.json()).toMatchObject({ outcome: 'created' });
  });

  it('write_file mode update rewrites an existing file and refuses a missing one with `missing`', async () => {
    const base = await start();
    const updated = await writeFile(base, { path: 'a.md', content: 'second draft', mode: 'update' });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ path: 'a.md', outcome: 'updated' });
    expect(await onDisk('a.md')).toBe('second draft');

    const missing = await writeFile(base, { path: 'nowhere.md', content: 'x', mode: 'update' });
    expect(missing.status).toBe(404);
    const body = (await missing.json()) as { error: string; code: string; path: string };
    expect(body.code).toBe('missing');
    expect(body.path).toBe('nowhere.md');
    expect(body.error).toContain('nowhere.md');
    await expect(onDisk('nowhere.md')).rejects.toThrow();
  });

  it('write_files answers for every requested path in input order, writes the rest, and counts only what landed', async () => {
    const base = await start();
    const res = await writeFiles(base, {
      files: [
        { path: 'one.md', content: 'first' },
        { path: 'a.md', content: 'clobbered' }, // already there
        { path: 'two.md', content: 'second' },
      ],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as BatchAnswer;
    expect(body.count).toBe(2);
    expect(body.files.map((f) => f.path)).toEqual(['one.md', 'a.md', 'two.md']);
    expect(body.files.map((f) => f.outcome)).toEqual(['created', 'refused', 'created']);
    expect(body.files[1].error).toBe('exists');
    expect(body.files[1].message).toContain('pass mode: overwrite to replace it');
    // The two it could write landed; the one it refused is untouched.
    expect(await onDisk('one.md')).toBe('first');
    expect(await onDisk('two.md')).toBe('second');
    expect(await onDisk('a.md')).toBe('hello\nworld\n');
  });

  it('write_files takes the same three modes', async () => {
    const base = await start();
    const overwritten = (await (await writeFiles(base, {
      mode: 'overwrite',
      files: [{ path: 'a.md', content: 'replaced text' }, { path: 'brand-new.md', content: 'new' }],
    })).json()) as BatchAnswer;
    expect(overwritten.count).toBe(2);
    expect(overwritten.files.map((f) => f.outcome)).toEqual(['replaced', 'created']);
    expect(await onDisk('a.md')).toBe('replaced text');

    const updated = (await (await writeFiles(base, {
      mode: 'update',
      files: [{ path: 'a.md', content: 'again' }, { path: 'never-written.md', content: 'x' }],
    })).json()) as BatchAnswer;
    expect(updated.count).toBe(1);
    expect(updated.files.map((f) => f.outcome)).toEqual(['updated', 'refused']);
    expect(updated.files[1].error).toBe('missing');
    await expect(onDisk('never-written.md')).rejects.toThrow();
  });

  it('write_files refuses a second create for a path an earlier entry in the SAME batch already claims', async () => {
    const base = await start();
    const body = (await (await writeFiles(base, {
      files: [{ path: 'dup.md', content: 'first' }, { path: 'dup.md', content: 'second' }],
    })).json()) as BatchAnswer;
    expect(body.count).toBe(1);
    expect(body.files.map((f) => f.outcome)).toEqual(['created', 'refused']);
    expect(body.files[1].error).toBe('exists');
    expect(await onDisk('dup.md')).toBe('first');
  });

  it('an empty batch is still an answer with both fields', async () => {
    const base = await start();
    expect(await (await writeFiles(base, { files: [] })).json()).toEqual({ count: 0, files: [] });
  });

  it('a mode that is not one of the three is refused, not read as the nearest one', async () => {
    const base = await start();
    for (const res of [
      await writeFile(base, { path: 'a.md', content: 'x', mode: 'replace' }),
      await writeFiles(base, { files: [{ path: 'a.md', content: 'x' }], mode: 'replace' }),
    ]) {
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; code: string };
      expect(body.code).toBe('bad_mode');
      expect(body.error).toContain('`create`, `overwrite`, `update`');
    }
    expect(await onDisk('a.md')).toBe('hello\nworld\n');
  });

  /**
   * The mode is a promise about the state the write lands on, so it has to be
   * judged over a state no one else can move — i.e. with the path's lock held,
   * not at a preflight anybody may invalidate before the bytes land. These
   * four drive that window directly: `raceHook` is the other writer, running
   * exactly where the real filesystem acquires the lock.
   */
  describe('the mode is judged over the state the write actually lands on', () => {
    it('write_file create refuses a path another writer created after the preflight, and keeps their file', async () => {
      const base = await start();
      raceHook = async () => { await fs.writeFile('contested.md', 'theirs\n'); };
      const res = await writeFile(base, { path: 'contested.md', content: 'mine' });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { code: string; path: string; error: string };
      expect(body.code).toBe('exists');
      expect(body.path).toBe('contested.md');
      expect(body.error).toContain('pass mode: overwrite to replace it');
      // The point of the whole feature: their bytes are still there.
      expect(await onDisk('contested.md')).toBe('theirs\n');
    });

    it('write_file update refuses a path another writer deleted after the preflight, and does not recreate it', async () => {
      const base = await start();
      raceHook = async () => { await fs.deleteFile('a.md'); };
      const res = await writeFile(base, { path: 'a.md', content: 'second draft', mode: 'update' });
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ code: 'missing', path: 'a.md' });
      await expect(onDisk('a.md')).rejects.toThrow();
    });

    it('write_file overwrite reports `replaced`, not `created`, when the file appeared after the preflight', async () => {
      const base = await start();
      raceHook = async () => { await fs.writeFile('late.md', 'theirs\n'); };
      const res = await writeFile(base, { path: 'late.md', content: 'mine', mode: 'overwrite' });
      expect(res.status).toBe(200);
      // The preflight saw nothing there and would have answered `created`.
      expect(await res.json()).toMatchObject({ path: 'late.md', outcome: 'replaced' });
      expect(await onDisk('late.md')).toBe('mine');
    });

    it('write_files drops only the path another writer took, lands the rest, and counts what landed', async () => {
      const base = await start();
      raceHook = async () => { await fs.writeFile('two.md', 'theirs\n'); };
      const body = (await (await writeFiles(base, {
        files: [
          { path: 'one.md', content: 'first' },
          { path: 'two.md', content: 'second' },
          { path: 'three.md', content: 'third' },
        ],
      })).json()) as BatchAnswer;
      expect(body.count).toBe(2);
      expect(body.files.map((f) => f.path)).toEqual(['one.md', 'two.md', 'three.md']);
      expect(body.files.map((f) => f.outcome)).toEqual(['created', 'refused', 'created']);
      expect(body.files[1].error).toBe('exists');
      expect(await onDisk('one.md')).toBe('first');
      expect(await onDisk('three.md')).toBe('third');
      expect(await onDisk('two.md')).toBe('theirs\n');
    });
  });

  it('both descriptions state the default and all three modes, and `mode` is an input on each', async () => {
    await start();
    const tools = await toolRegistry.listInternal();
    for (const name of ['write_file', 'write_files']) {
      const def = tools.find((t) => t.name === name)!;
      expect(def.description, name).toContain('DEFAULTS TO `create`');
      for (const mode of ['`create`', '`overwrite`', '`update`']) {
        expect(def.description, `${name} ${mode}`).toContain(mode);
      }
      const body = (def.inputs as { properties: { body: { properties: Record<string, { enum?: string[]; description?: string }> } } }).properties.body;
      expect(body.properties.mode, name).toBeDefined();
      expect(body.properties.mode.enum, name).toEqual(['create', 'overwrite', 'update']);
      expect(body.properties.mode.description, name).toContain('default `create`');
    }
  });

  /**
   * The audited-caller case, as a KB fixture: a skill whose step rewrites a
   * ticket card it has just read (the shape every delivery skill uses to
   * append to a ticket's log). It keeps working because the rewrite says
   * `mode: overwrite` — and the same step WITHOUT the mode is refused, which
   * is exactly the signal the audit was for.
   */
  it('a skill that rewrites a ticket card it just read still works, because it passes mode: overwrite', async () => {
    const base = await start();
    const card = `${KB_DIR}/Data/Tickets/Ship-It.md`;
    await fs.mkdir(`${KB_DIR}/Data/Tickets`, { recursive: true });
    await fs.writeFile(card, '# Ship It\n\n# Log\n- filed\n');

    const read = (await (await post(`${base}/api/agent/tools/read_file`, { path: card })).json()) as { content: string };
    const updatedCard = `${read.content}- coding done\n`;

    // The step as the skill writes it today, with no mode: refused, card intact.
    const blind = await writeFile(base, { path: card, content: updatedCard });
    expect(blind.status).toBe(409);
    expect(await onDisk(card)).toBe('# Ship It\n\n# Log\n- filed\n');

    // The audited step, saying what it means: the rewrite lands.
    const audited = await writeFile(base, { path: card, content: updatedCard, mode: 'overwrite' });
    expect(audited.status).toBe(200);
    expect(await audited.json()).toMatchObject({ path: card, outcome: 'replaced' });
    expect(await onDisk(card)).toBe('# Ship It\n\n# Log\n- filed\n- coding done\n');

    // …and the same step through the batch tool, which the skills use to land
    // a card and its transcript in ONE commit.
    const both = (await (await writeFiles(base, {
      mode: 'overwrite',
      files: [
        { path: card, content: `${updatedCard}- local testing done\n` },
        { path: `${KB_DIR}/Data/Tickets/Ship-It/transcripts/02-coding.md`, content: '# transcript\n' },
      ],
    })).json()) as BatchAnswer;
    expect(both.count).toBe(2);
    expect(both.files.map((f) => f.outcome)).toEqual(['replaced', 'created']);
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
      expect(res.status, tool).toBe(415);
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
      expect(res.status, tool).toBe(415);
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
      expect(res.status, tool).toBe(415);
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
    ] as const) {
      const res = await post(`${base}/api/agent/tools/${tool}`, body);
      expect(res.status, tool).toBe(415);
      const { error } = (await res.json()) as { error: string };
      expect(error, tool).toContain('EXTRACTED text');
      expect(error, tool).toContain('uploading a new version');
    }
    // In a BATCH the same refusal is per path: the document is refused with the
    // same explanation, and the innocent .md beside it is still written.
    for (const doc of ['sheet.xlsx', 'sheet.ods']) {
      const res = await post(`${base}/api/agent/tools/write_files`, {
        files: [{ path: `ok-${doc}.md`, content: 'fine' }, { path: doc, content: 'nope' }],
      });
      expect(res.status, doc).toBe(200);
      const body = (await res.json()) as { count: number; files: { path: string; outcome: string; error?: string; message?: string }[] };
      expect(body.count, doc).toBe(1);
      expect(body.files.map((f) => f.path), doc).toEqual([`ok-${doc}.md`, doc]);
      expect(body.files[0], doc).toMatchObject({ outcome: 'created' });
      expect(body.files[1], doc).toMatchObject({ outcome: 'refused', error: 'binary_not_writable' });
      expect(body.files[1].message, doc).toContain('EXTRACTED text');
      expect(body.files[1].message, doc).toContain('uploading a new version');
      expect(await readContent(base, `ok-${doc}.md`)).toBe('fine');
      expect((await post(`${base}/api/agent/tools/file_stat`, { path: doc })).status, doc).not.toBe(200);
    }
    // And the pptx is untouched: reading it still extracts the original text.
    expect(await readContent(base, 'deck.pptx')).toContain('Original');
  });

  it('every file tool states the SAME content rule — refused families, the byte tools and the upload path — so agents learn before the call', async () => {
    await start();
    const tools = await toolRegistry.listInternal();
    const fileTools = ['read_file', 'list_files', 'file_stat', 'grep', 'write_file', 'write_files', 'edit_file', 'delete_file', 'mkdir', 'move_file', 'copy_file', 'unzip'];
    for (const name of fileTools) {
      const def = tools.find((t) => t.name === name);
      expect(def, name).toBeDefined();
      // One constant, verbatim — the description is what tools_info returns.
      expect(def!.description, name).toContain(CONTENT_RULE);
      expect(def!.description, name).toContain('`binary_not_writable`');
      expect(def!.description, name).toContain('copy_file, move_file, delete_file and unzip act on bytes of any kind');
      expect(def!.description, name).toContain('`request_upload_token` + `apply_upload`');
      expect(def!.description, name).toContain('`contentMode`');
      // Modern extractable formats…
      expect(def!.description, name).toContain('.docx/.pptx/.xlsx/.odt/.odp/.ods/.pdf');
      // …email files (extractions too, so the same refusal applies)…
      expect(def!.description, name).toContain('.eml/.msg');
      // …the legacy binary family the refusal also covers…
      expect(def!.description, name).toContain('.doc/.ppt/.xls');
    }
    // The shell is not a file tool: it does not carry the rule.
    expect(tools.find((t) => t.name === 'execute_command')!.description).not.toContain(CONTENT_RULE);
  });

  describe('binary capability contract: a text file, a document, an image and a zip', () => {
    const PNG = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64',
    );
    const zipBytes = (): Buffer => {
      const z = new AdmZip();
      z.addFile('inner.md', Buffer.from('# inner\n'));
      return z.toBuffer();
    };
    /** Seed the four kinds; returns each path with its exact bytes and expected answers. */
    const seed = async () => {
      const files = [
        { path: 'notes.md', bytes: Buffer.from('hello text\n'), mode: 'text', kind: null },
        { path: 'deck.pptx', bytes: pptx([['Original']]), mode: 'document', kind: 'document' },
        { path: 'logo.png', bytes: PNG, mode: 'binary', kind: 'image' },
        { path: 'bundle.zip', bytes: zipBytes(), mode: 'binary', kind: 'archive' },
      ] as const;
      for (const f of files) await fs.writeFile(f.path, f.bytes);
      return files;
    };
    const onDisk = async (path: string) => Buffer.from(await readFile(join(tempDir, path)));
    interface Refusal { error: string; kind: string; fileKind: string; useInstead: string[] }
    const expectRefusal = async (res: Response, fileKind: string, label: string) => {
      expect(res.status, label).toBe(415);
      const body = (await res.json()) as Refusal;
      expect(body.kind, label).toBe('binary_not_writable');
      expect(body.fileKind, label).toBe(fileKind);
      expect(body.useInstead, label).toEqual(['upload', 'copy_file', 'move_file']);
      // The prose names the kind and the alternatives too, for a caller that only sees the message.
      expect(body.error, label).toContain(`this file's kind is ${fileKind};`);
      expect(body.error, label).toContain('upload');
      expect(body.error, label).toContain('copy_file / move_file');
    };
    /** The same refusal, as `write_files` reports it: per path, inside a 200. */
    const expectBatchRefusal = async (res: Response, fileKind: string, label: string) => {
      expect(res.status, label).toBe(200);
      const body = (await res.json()) as { count: number; files: { outcome: string; error?: string; message?: string }[] };
      expect(body.count, label).toBe(0);
      expect(body.files[0].outcome, label).toBe('refused');
      expect(body.files[0].error, label).toBe('binary_not_writable');
      expect(body.files[0].message, label).toContain(`this file's kind is ${fileKind};`);
    };

    it('file_stat reports contentMode text | document | binary', async () => {
      const base = await start();
      for (const f of await seed()) {
        const stat = (await (await post(`${base}/api/agent/tools/file_stat`, { path: f.path })).json()) as Record<string, unknown>;
        expect(stat.type, f.path).toBe('file');
        expect(stat.contentMode, f.path).toBe(f.mode);
      }
      // Binary content under a text name is binary: write_file would refuse it.
      await fs.writeFile('blob.dat', Buffer.from([0x00, 0xff]));
      const blob = (await (await post(`${base}/api/agent/tools/file_stat`, { path: 'blob.dat' })).json()) as Record<string, unknown>;
      expect(blob.contentMode).toBe('binary');
      // A directory has no content mode.
      await fs.mkdir('dir', { recursive: true });
      const dir = (await (await post(`${base}/api/agent/tools/file_stat`, { path: 'dir' })).json()) as Record<string, unknown>;
      expect(dir.contentMode).toBeUndefined();
      expect(dir.kind).toBeUndefined();
    });

    it('file_stat classifies a file the way read_file does: kind, mime, mimeSource, textEditable', async () => {
      const base = await start();
      const stat = async (path: string) =>
        (await (await post(`${base}/api/agent/tools/file_stat`, { path })).json()) as Record<string, unknown>;
      // Extensionless UTF-8: read_file returns its text, so stat says text/plain.
      await fs.writeFile('Sample file', Buffer.from('plain words, no extension\n'));
      expect(await (await post(`${base}/api/agent/tools/read_file`, { path: 'Sample file' })).json()).toMatchObject({ content: 'plain words, no extension\n' });
      expect(await stat('Sample file')).toMatchObject({ type: 'file', kind: 'text', mime: 'text/plain', mimeSource: 'sniff', textEditable: true });
      expect(await stat('Sample file')).not.toHaveProperty('mimeNote');
      // The filesystem's own mimeType (a second extension table: octet-stream
      // here) is not passed through, so nothing in the answer contradicts `mime`.
      expect((await fs.stat('Sample file')).mimeType).toBeDefined();
      await fs.writeFile('notes.md', Buffer.from('# notes\n'));
      await fs.mkdir('folder', { recursive: true });
      for (const p of ['Sample file', 'notes.md', 'folder']) {
        expect(await stat(p), p).not.toHaveProperty('mimeType');
      }
      expect(await stat('notes.md')).toMatchObject({ kind: 'text', mime: 'text/plain' });
      await fs.writeFile('plata.pdf', Buffer.from('%PDF-1.4\n'));
      expect(await stat('plata.pdf')).toMatchObject({ kind: 'document', mime: 'application/pdf', textEditable: false });
      await seed();
      expect(await stat('deck.pptx')).toMatchObject({ kind: 'document', mimeSource: 'extension', textEditable: false });
      expect(await stat('logo.png')).toMatchObject({ kind: 'image', mime: 'image/png', textEditable: false });
      // Real binary bytes without a known extension: the octet-stream fallback, and a note saying so.
      await fs.writeFile('Sample blob', Buffer.from([0x00, 0x01, 0xff]));
      const blob = await stat('Sample blob');
      expect(blob).toMatchObject({ kind: 'binary', mime: 'application/octet-stream', mimeSource: 'fallback', textEditable: false });
      expect(blob.mimeNote).toBe(OCTET_STREAM_FALLBACK_NOTE);
    });

    it('write_file, write_files and edit_file accept the text file and refuse the other three with binary_not_writable, bytes untouched', async () => {
      const base = await start();
      // The plain test filesystem has no batch commit; give it one that lands
      // each write, so the text batch must actually SUCCEED past the gate.
      (fs as unknown as { writeFiles: (writes: { path: string; content: string }[]) => Promise<void> }).writeFiles = async (writes) => {
        for (const w of writes) await fs.writeFile(w.path, w.content);
      };
      const files = await seed();
      for (const f of files) {
        // Every seeded file already exists, so the write says it means to replace it.
        const write = await post(`${base}/api/agent/tools/write_file`, { path: f.path, content: 'plain text', mode: 'overwrite' });
        const batch = await post(`${base}/api/agent/tools/write_files`, { files: [{ path: f.path, content: 'plain text' }], mode: 'overwrite' });
        const edit = await post(`${base}/api/agent/tools/edit_file`, { path: f.path, old_string: 'a', new_string: 'b' });
        if (f.kind === null) {
          expect(write.status, f.path).toBe(200);
          expect(batch.status, f.path).toBe(200);
          // Content is now 'plain text', so 'a' is found once.
          expect(edit.status, f.path).toBe(200);
          expect((await onDisk(f.path)).toString('utf8')).toBe('plbin text');
          continue;
        }
        await expectRefusal(write, f.kind, `write_file ${f.path}`);
        await expectBatchRefusal(batch, f.kind, `write_files ${f.path}`);
        await expectRefusal(edit, f.kind, `edit_file ${f.path}`);
        expect((await onDisk(f.path)).equals(f.bytes), f.path).toBe(true);
      }
      // Creating a NEW image or zip by text is refused the same way — nothing lands.
      await expectRefusal(await post(`${base}/api/agent/tools/write_file`, { path: 'new.png', content: 'x' }), 'image', 'new.png');
      await expectRefusal(await post(`${base}/api/agent/tools/write_file`, { path: 'new.zip', content: 'x' }), 'archive', 'new.zip');
      expect((await post(`${base}/api/agent/tools/file_stat`, { path: 'new.png' })).status).not.toBe(200);
    });

    it('copy_file and move_file carry every kind byte-for-byte', async () => {
      const base = await start();
      for (const f of await seed()) {
        const copied = await post(`${base}/api/agent/tools/copy_file`, { src: f.path, dest: `copies/${f.path}` });
        expect(copied.status, f.path).toBe(200);
        expect((await onDisk(`copies/${f.path}`)).equals(f.bytes), `copy ${f.path}`).toBe(true);
        const moved = await post(`${base}/api/agent/tools/move_file`, { src: f.path, dest: `moved/${f.path}` });
        expect(moved.status, f.path).toBe(200);
        expect((await onDisk(`moved/${f.path}`)).equals(f.bytes), `move ${f.path}`).toBe(true);
      }
      // The moved zip is still a real archive: unzip reads it as bytes.
      const z = new AdmZip(await onDisk('moved/bundle.zip'));
      expect(z.getEntry('inner.md')?.getData().toString('utf8')).toBe('# inner\n');
    });
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

  async function startSessionApp(
    source: 'external' | 'internal' = 'external',
    // The default fake returns one fixed id, which is what most of these
    // assertions want. The load reproduction below substitutes the REAL
    // `UuidSessionSink`, because "did fifty first calls collide?" is a question
    // only the real minting can answer.
    sink?: ISessionSink,
  ): Promise<string> {
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
      sink ?? fakeSessionSink,
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

  /**
   * The load reproduction, platform side.
   *
   * The report behind this was one first call on a fresh connection failing
   * with a generic error, an immediate retry working, and the error carrying a
   * `req_011…` id — the Anthropic API's request-id shape, which nothing here
   * mints. The hypothesis was that the failure never reached the tool. These
   * run the real `UuidSessionSink` behind the real route, fifty calls at once,
   * so the hypothesis stops being the only account of what the route does
   * under a burst.
   *
   * `first-call-probe.ts` (and its suite) does the same over a real MCP
   * transport; this one strips the transport away so a future failure can be
   * placed on one side of it or the other.
   */
  describe('fifty first calls at once', () => {
    it('answers every one of them with a session id of its own', async () => {
      const base = await startSessionApp('external', new UuidSessionSink());

      const responses = await Promise.all(Array.from({ length: 50 }, () => post(`${base}/api/agent/tools/start_session`)));
      const bodies = (await Promise.all(responses.map((r) => r.json()))) as Array<{ sessionId?: string }>;

      expect(responses.map((r) => r.status)).toEqual(Array.from({ length: 50 }, () => 200));
      // Fifty ids, no collision and no blank: a burst is not one id handed out
      // repeatedly, and it is not a partially-served queue either.
      expect(new Set(bodies.map((b) => b.sessionId)).size).toBe(50);
      expect(bodies.every((b) => typeof b.sessionId === 'string' && b.sessionId.length > 0)).toBe(true);
    });

    it('mints nothing when the call fails, so the retry the description promises is safe', async () => {
      // A sink that fails the first call and serves the second is the reported
      // sequence exactly. What the retry must NOT inherit is any state the
      // failed call left — and there is none to inherit, because a failed mint
      // never reached the point of producing an id.
      let calls = 0;
      const flaky: ISessionSink = {
        createSession: async () => {
          calls++;
          if (calls === 1) throw new Error('sink unavailable');
          return { sessionId: `session-${calls}` };
        },
      };
      const base = await startSessionApp('external', flaky);

      // The route logs the sink's failure — correct behaviour, and expected
      // here, so it is kept out of the suite's output rather than left to look
      // like a real fault. Restored in a `finally`: if the request itself
      // rejected, an un-restored spy would go on swallowing console.error for
      // every later test in this file, and they would pass while saying nothing.
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
      let failed: Awaited<ReturnType<typeof post>>;
      try {
        failed = await post(`${base}/api/agent/tools/start_session`);
      } finally {
        errorLog.mockRestore();
      }
      expect(failed.status).toBeGreaterThanOrEqual(500);

      const retried = (await (await post(`${base}/api/agent/tools/start_session`)).json()) as { sessionId: string };
      expect(retried.sessionId).toBe('session-2');
      expect(calls).toBe(2);
    });

    it('gives a retry that lands after a success a NEW id, leaving the first one usable', async () => {
      // The harmless case the description calls out: a client that retries a
      // call which had in fact succeeded ends up holding two ids. Neither
      // supersedes the other — the run keeps using the one it already passed
      // to other tools, and the spare is simply never mentioned again.
      const base = await startSessionApp('external', new UuidSessionSink());

      const first = (await (await post(`${base}/api/agent/tools/start_session`)).json()) as { sessionId: string };
      const retry = (await (await post(`${base}/api/agent/tools/start_session`)).json()) as { sessionId: string };

      expect(retry.sessionId).not.toBe(first.sessionId);
      expect(first.sessionId).toBeTruthy();
    });
  });

  it('tells the caller, in the tool description, that a failed call can be retried', async () => {
    const registry = new ToolRegistry();
    const router = express.Router();
    const noopAuth: express.RequestHandler = (_req, _res, next) => next();
    registerWorkspaceTools(
      registry, router, noopAuth, (() => () => {}) as never,
      new SpillStore(join(tmpdir(), 'bevel-test-spills')), new DocExtractService(join(tmpdir(), 'bevel-test-doc-extract')), allowAll, KB_DIR,
      { service: {} as never, enabled: false, kbDirName: KB_DIR, recoveryBotEmail: 'recovery-bot@bevel.local', hooks: new WorkflowHooks() },
      new RoutineWritePolicyService(),
      {} as never,
    );

    const description = (await registry.listExternal()).find((t) => t.name === 'start_session')?.description ?? '';

    // The three things a caller has to be told, and the reason the ticket asked
    // for them: without the first two a transport hiccup reads as a dead end,
    // and without the third a client that already retried thinks it has
    // corrupted its own run.
    expect(description).toMatch(/retry/i);
    expect(description).toMatch(/created nothing/i);
    expect(description).toMatch(/harmless/i);
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
 * A folder exists until someone deletes it, and its placeholder is never shown
 * as content — the agent tools' half (the UI routes' half lives in
 * `workspace.routes.folders.test.ts`). The filesystem here is a plain
 * LocalFilesystem, so "committed" is proven the way git sees it: a real
 * repository in the clone folder, committed and freshly cloned.
 */
describe('folders never vanish', () => {
  const KB = (p: string) => `${KB_DIR}/${p}`;
  const tool = async (base: string, name: string, body: Record<string, unknown>) => {
    const res = await post(`${base}/api/agent/tools/${name}`, body);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const names = async (base: string, dir: string) =>
    ((await tool(base, 'list_files', { path: dir })).body.entries as { name: string; type: string }[]).map(
      (e) => `${e.name}:${e.type}`,
    );
  const gitIn = (cwd: string, args: string[]) =>
    promisify(execFile)('git', args, {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x',
      },
    });

  it('list_files, file_stat and grep never show the placeholder', async () => {
    const base = await start();
    await fs.writeFile(KB('Docs/note.md'), 'marker');
    await fs.writeFile(KB('Docs/.gitkeep'), 'marker');
    await fs.writeFile(KB('Docs/Empty/.gitkeep'), '');

    expect((await names(base, KB('Docs'))).sort()).toEqual(['Empty:directory', 'note.md:file']);
    expect(await names(base, KB('Docs/Empty'))).toEqual([]);

    const missing = await tool(base, 'file_stat', { path: KB('Docs/nothing-here.md') });
    const placeholder = await tool(base, 'file_stat', { path: KB('Docs/.gitkeep') });
    expect(missing.status).toBe(404);
    // The placeholder is nothing, and it says so in the one shape every file
    // tool uses for a path with nothing at it (see not-found.ts).
    expect(placeholder).toEqual({
      status: 404,
      body: {
        kind: 'not_found',
        path: KB('Docs/.gitkeep'),
        error: `There is no file or directory at "${KB('Docs/.gitkeep')}" in this workspace. ${NOT_FOUND_NEXT_STEP}`,
      },
    });
    expect((await tool(base, 'file_stat', { path: KB('Docs/Empty') })).body).toMatchObject({ type: 'directory' });

    const grep = await tool(base, 'grep', { pattern: 'marker' });
    expect((grep.body.matches as { path: string }[]).map((m) => m.path)).toEqual([KB('Docs/note.md')]);
    expect((await tool(base, 'grep', { pattern: 'marker', path: KB('Docs/.gitkeep') })).status).toBe(404);
  });

  it('delete_folder removes its folder but keeps the one that held it, placeholder not counted as content', async () => {
    const base = await start();
    await fs.writeFile(KB('Parent/Child/a.md'), 'a');
    await fs.writeFile(KB('Parent/Child/.gitkeep'), '');

    // The placeholder goes with the folder, but it is not a file the caller
    // is told about or asked to confirm.
    const dry = await tool(base, 'delete_folder', { path: KB('Parent/Child'), dryRun: true });
    expect(dry.body).toMatchObject({ descendants: 1, files: [KB('Parent/Child/a.md')] });
    expect((await tool(base, 'file_stat', { path: KB('Parent/Child') })).body).toMatchObject({ descendants: 1 });

    const run = await tool(base, 'delete_folder', { path: KB('Parent/Child'), confirm: true });
    expect(run.body).toMatchObject({ deleted: true });
    expect(await fs.exists(KB('Parent/Child'))).toBe(false);
    // `Parent` was not deleted: now empty, it stays, listed as an empty folder.
    expect(await names(base, KB(''))).toContain('Parent:directory');
    expect(await names(base, KB('Parent'))).toEqual([]);
    expect(await fs.exists(KB('Parent/.gitkeep'))).toBe(true);
  });

  it('a folder holding only its placeholder is empty: deleted without confirm, reporting no files', async () => {
    const base = await start();
    await fs.writeFile(KB('Holder/Empty/.gitkeep'), '');
    await fs.writeFile(KB('Holder/keep.md'), 'k');

    const run = await tool(base, 'delete_folder', { path: KB('Holder/Empty') });
    expect(run.body).toMatchObject({ deleted: true, descendants: 0, files: [] });
    expect(await fs.exists(KB('Holder/Empty'))).toBe(false);
    // `Holder` still has content of its own, so it needs no placeholder.
    expect(await fs.exists(KB('Holder/.gitkeep'))).toBe(false);
  });

  it('move_file of a whole folder out keeps the folder it came from', async () => {
    const base = await start();
    await fs.writeFile(KB('Src/Inner/x.md'), 'x');

    expect((await tool(base, 'move_file', { src: KB('Src/Inner'), dest: KB('Dst/Inner') })).status).toBe(200);
    expect(await fs.exists(KB('Dst/Inner/x.md'))).toBe(true);
    expect(await names(base, KB('Src'))).toEqual([]);
    expect(await fs.exists(KB('Src/.gitkeep'))).toBe(true);
  });

  it('delete_file on the last file keeps the folder, and it survives a fresh clone', async () => {
    const base = await start();
    const repo = join(tempDir, KB_DIR);
    await fs.writeFile(KB('nested/level-two/notes.md'), 'x');
    await gitIn(repo, ['init', '-q', '-b', 'main']);
    await gitIn(repo, ['add', '-A']);
    await gitIn(repo, ['commit', '-qm', 'seed']);

    expect((await tool(base, 'delete_file', { path: KB('nested/level-two/notes.md') })).status).toBe(200);

    expect(await names(base, KB('nested'))).toEqual(['level-two:directory']);
    expect(await names(base, KB('nested/level-two'))).toEqual([]);
    // What the lock-aware filesystem commits on release, committed here by hand.
    await gitIn(repo, ['add', '-A']);
    await gitIn(repo, ['commit', '-qm', 'delete']);
    await gitIn(tempDir, ['clone', '-q', repo, 'fresh-clone']);
    expect((await fs.stat('fresh-clone/nested/level-two')).type).toBe('directory');
  });

  it('delete_file with siblings left, or at the clone folder itself, writes no placeholder', async () => {
    const base = await start();
    await fs.writeFile(KB('full/a.md'), 'a');
    await fs.writeFile(KB('full/b.md'), 'b');
    await fs.writeFile(KB('top.md'), 't');

    expect((await tool(base, 'delete_file', { path: KB('full/a.md') })).status).toBe(200);
    expect((await tool(base, 'delete_file', { path: KB('top.md') })).status).toBe(200);
    expect((await tool(base, 'delete_file', { path: 'a.md' })).status).toBe(200);

    expect(await names(base, KB('full'))).toEqual(['b.md:file']);
    await expect(fs.exists(KB('full/.gitkeep'))).resolves.toBe(false);
    await expect(fs.exists(KB('.gitkeep'))).resolves.toBe(false);
    await expect(fs.exists('.gitkeep')).resolves.toBe(false);
  });

  it('delete_file keeps the folder in its folder turn, on the branch it was given', async () => {
    const base = await start();
    await fs.writeFile(KB('turned/only.md'), 'x');

    expect((await tool(base, 'delete_file', { path: KB('turned/only.md'), branch: 'alice/draft' })).status).toBe(200);
    expect(folderTurns).toEqual([`alice%2Fdraft:${KB('turned')}`]);
  });

  it('delete_file fails when the emptied folder cannot be kept, and says the file is gone', async () => {
    const base = await start();
    await fs.writeFile(KB('unkeepable/only.md'), 'x');
    const write = fs.writeFile.bind(fs);
    const spy = vi.spyOn(fs, 'writeFile').mockImplementation(async (p, ...rest) => {
      if (p.endsWith('.gitkeep')) throw new Error('disk full');
      return write(p, ...rest);
    });

    let res: Awaited<ReturnType<typeof tool>>;
    try {
      res = await tool(base, 'delete_file', { path: KB('unkeepable/only.md') });
    } finally {
      spy.mockRestore();
    }
    expect(res.status).toBe(500);
    expect(res.body.error).toBe(
      `"${KB('unkeepable/only.md')}" was removed, but its folder "${KB('unkeepable')}" could not be kept: disk full`,
    );
    await expect(fs.exists(KB('unkeepable/only.md'))).resolves.toBe(false);
  });

  it('move_file of the last file keeps the source folder', async () => {
    const base = await start();
    await fs.writeFile(KB('from/a.md'), 'a');

    expect((await tool(base, 'move_file', { src: KB('from/a.md'), dest: KB('to/a.md') })).status).toBe(200);

    expect((await names(base, KB(''))).sort()).toEqual(['from:directory', 'to:directory']);
    expect(await names(base, KB('from'))).toEqual([]);
    await expect(fs.exists(KB('from/.gitkeep'))).resolves.toBe(true);
  });

  it('mkdir, a nested write, and an emptied folder converge on the same state', async () => {
    const base = await start();
    await tool(base, 'mkdir', { path: KB('Made') });
    await tool(base, 'write_file', { path: KB('Written/n.md'), content: 'n' });

    expect((await names(base, KB(''))).sort()).toEqual(['Made:directory', 'Written:directory']);
    expect(await names(base, KB('Made'))).toEqual([]);

    await tool(base, 'delete_file', { path: KB('Written/n.md') });
    expect((await names(base, KB(''))).sort()).toEqual(['Made:directory', 'Written:directory']);
    expect(await names(base, KB('Written'))).toEqual(await names(base, KB('Made')));
    expect((await tool(base, 'file_stat', { path: KB('Written') })).body).toMatchObject({ type: 'directory' });
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
    if (rel === 'sealed.md' || rel.endsWith('/sealed.md')) return { read: true, write: false, download: false, owner: false };
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

    /**
     * "A file named rules.md already exists in Locked." is a fact about a
     * folder. Answering it before the write verdict turned these tools into an
     * existence oracle: a caller who may not write `Locked/` — and on a
     * protected branch that is most callers — could ask for a name and read
     * off whether it is taken. The two calls below differ ONLY in whether the
     * destination exists, and must be indistinguishable.
     */
    it('a destination the caller may not write answers the same whether the name is taken or free', async () => {
      const base = await seeded();
      const taken = { src: KB('Sales/deal.md'), dest: KB('Locked/rules.md') };
      const free = { src: KB('Sales/deal.md'), dest: KB('Locked/free.md') };

      const ontoTaken = await call(base, 'move_file', taken);
      const ontoFree = await call(base, 'move_file', free);
      expect(ontoTaken.status).toBe(403);
      expect(ontoTaken.status).toBe(ontoFree.status);
      expect(ontoTaken.body.kind).toBe('write-denied');
      expect(ontoTaken.body.error).not.toContain('already exists');
      // Same shape, same words — only the path each names differs.
      expect(ontoTaken.body.error.replace('rules.md', 'free.md')).toBe(ontoFree.body.error);

      // The dry run is the easier oracle to reach, and says the same.
      const dryTaken = await call(base, 'move_file', { ...taken, dryRun: true });
      const dryFree = await call(base, 'move_file', { ...free, dryRun: true });
      expect(dryTaken.body).toMatchObject({ allowed: false });
      expect(dryTaken.body.reason).not.toContain('already exists');
      expect(dryTaken.body.reason.replace('rules.md', 'free.md')).toBe(dryFree.body.reason);

      // And nothing was moved onto the name that was taken.
      expect(await fs.readFile(KB('Locked/rules.md'), { encoding: 'utf-8' })).toBe('rules');
      expect(await exists(KB('Sales/deal.md'))).toBe(true);
    });

    it('copy_file keeps the same order: the write refusal, not what is in the folder', async () => {
      const base = await seeded();

      const ontoTaken = await call(base, 'copy_file', { src: KB('Sales/deal.md'), dest: KB('Locked/rules.md') });
      const ontoFree = await call(base, 'copy_file', { src: KB('Sales/deal.md'), dest: KB('Locked/free.md') });
      expect(ontoTaken.status).toBe(403);
      expect(ontoTaken.status).toBe(ontoFree.status);
      expect(ontoTaken.body.kind).toBe('write-denied');
      expect(ontoTaken.body.error).not.toContain('already exists');
      expect(ontoTaken.body.error.replace('rules.md', 'free.md')).toBe(ontoFree.body.error);

      expect(await fs.readFile(KB('Locked/rules.md'), { encoding: 'utf-8' })).toBe('rules');
      expect(await exists(KB('Locked/free.md'))).toBe(false);
    });

    it('a move the caller may not write: the dry run says so, the real call is a write-denied with proposal steps', async () => {
      const base = await seeded();
      const args = { src: KB('Sales/deal.md'), dest: KB('Locked/deal.md') };
      const dry = await call(base, 'move_file', { ...args, dryRun: true });
      expect(dry.body).toMatchObject({ allowed: false });
      expect(dry.body.reason).toContain(KB('Locked/deal.md'));

      const run = await call(base, 'move_file', args);
      expect(run.status).toBe(403);
      expect(run.body).toMatchObject({ kind: 'write-denied', path: KB('Locked/deal.md'), canPropose: true });
      expect(run.body.reason).toContain('Eligible: Admin');
      // `reason` is what the refusal said; `error` is the sentence the agent
      // reads, which carries it plus the invitation to propose.
      expect(run.body.error).toContain('Eligible: Admin');
      expect(run.body.error).toContain('You may propose this change instead');
      expect(run.body.proposal.targetBranch).toBe(PROTECTED);
      expect(run.body.proposal.steps.map((s: { tool: string }) => s.tool)).toEqual([
        'create_branch',
        'move_file',
        'open_change_request',
      ]);
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
      expect(run.body).toMatchObject({ kind: 'write-denied', path: KB('Sales/archive/nested/sealed.md'), canPropose: true });
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
      expect(run.body).toMatchObject({ kind: 'write-denied' });
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
      expect(run.body).toMatchObject({ kind: 'write-denied', canPropose: false });
      expect(run.body.proposal).toBeUndefined();
      expect(run.body.cannotProposeReason).toContain('you cannot read this path');
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

    it('every one of the four platform files gets the same sentence, and the agent never gets the admin restore', async () => {
      // The agent move tool has no exception: the recovery move is a person's,
      // made as an admin, and an agent is neither.
      const base = await seeded();
      await fs.writeFile(KB('roles.yaml'), 'roles: {}\n');
      await fs.writeFile(KB('AGENTS.md'), 'agents\n');
      await fs.writeFile(KB('.bevelignore'), '*.tmp\n');
      await fs.writeFile(KB('Misplaced/access.md'), '---\nread: everyone\n---\n');
      const cases: [string, string][] = [
        [KB('access.md'), KB('Sales/access.md')],
        [KB('roles.yaml'), KB('Sales/roles.yaml')],
        [KB('.bevelignore'), KB('Sales/.bevelignore')],
        [KB('AGENTS.md'), KB('Sales/AGENTS.md')],
        // Including the shape of the admin's recovery move: a misplaced
        // access.md into a folder that has none. A person holding the Admin
        // role is allowed exactly this move from the UI; the agent is not.
        [KB('Misplaced/access.md'), KB('HR/access.md')],
      ];
      for (const [src, dest] of cases) {
        const name = src.slice(src.lastIndexOf('/') + 1);
        const sentence = `${name} is a platform file and stays in its folder.`;
        expect((await call(base, 'move_file', { src, dest, dryRun: true })).body)
          .toMatchObject({ allowed: false, reason: sentence });
        const run = await call(base, 'move_file', { src, dest, confirm: true });
        expect(run.status).toBe(400);
        expect(run.body.error).toBe(sentence);
        expect(await exists(src)).toBe(true);
      }
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
      expect(run.body).toMatchObject({ kind: 'write-denied', canPropose: true });
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
      expect(run.body).toMatchObject({ kind: 'write-denied', path: KB('Locked/rules.md'), canPropose: true });
      expect(run.body.proposal.steps.map((s: { tool: string }) => s.tool)).toContain('delete_file');
    });
    it('a refusal from the lock gate itself (rules changed after the preflight) is the structured denial too', async () => {
      const base = await seeded();
      fs.deleteFile = async (p: string) => {
        throw new AccessDeniedError({ path: p, eligibleRoles: ['Admin'], eligibleUsers: [] });
      };
      const run = await call(base, 'delete_file', { path: KB('Sales/deal.md') });
      expect(run.status).toBe(403);
      expect(run.body).toMatchObject({ kind: 'write-denied', path: KB('Sales/deal.md'), canPropose: true });
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

    // The git folder is not merely "managed": it is not reachable at all, so
    // every one of these is the one sanitized refusal (`shared/git-internals.ts`)
    // rather than this preflight's own "git metadata" answer — a dry run
    // included, since even describing what is in there is not on offer.
    it('git metadata is refused, and a folder walk never enters it', async () => {
      const base = await seeded();
      await fs.writeFile(KB('.git/HEAD'), 'ref: refs/heads/main\n');
      await fs.writeFile(KB('Sales/sub/.git/HEAD'), 'ref: refs/heads/main\n');
      for (const call_ of [
        { tool: 'delete_folder', args: { path: KB('.git'), dryRun: true } },
        { tool: 'delete_folder', args: { path: KB('.git'), confirm: true } },
        { tool: 'delete_file', args: { path: KB('.git/HEAD') } },
        { tool: 'move_file', args: { src: KB('.git'), dest: KB('Sales/git') } },
      ]) {
        const res = await call(base, call_.tool, call_.args);
        expect({ tool: call_.tool, status: res.status, error: res.body.error }).toEqual({
          tool: call_.tool,
          status: 403,
          error: GIT_INTERNALS_MESSAGE,
        });
      }
      expect(await exists(KB('.git/HEAD'))).toBe(true);
      expect((await call(base, 'file_stat', { path: KB('Sales/sub') })).body).toMatchObject({ descendants: 0 });
    });

    it('a folder\'s own access.md goes with it, in the same single change as every other file', async () => {
      const base = await seeded();
      await fs.writeFile(KB('Sales/archive/access.md'), '---\nread: everyone\n---\n');
      // What the TOOL decides is the shape it hands the filesystem: ONE batch
      // carrying every file, the folder's own access.md among them. That the
      // batch then lands all-or-nothing is the batch's own property, asserted
      // in locking-filesystem.test.ts; the harness stand-in here only applies
      // the deletes.
      const batches: string[][] = [];
      const fsAny = fs as unknown as Record<string, unknown>;
      const writeFiles = fsAny.writeFiles as (w: unknown[], s: string, d: string[]) => Promise<void>;
      fsAny.writeFiles = async (w: unknown[], s: string, d: string[] = []) => {
        batches.push([...d]);
        return writeFiles(w, s, d);
      };

      const run = await call(base, 'delete_folder', { path: KB('Sales/archive'), confirm: true });

      expect(run.body).toMatchObject({ deleted: true, descendants: 4 });
      expect(batches).toHaveLength(1);
      expect([...batches[0]].sort()).toEqual([
        KB('Sales/archive/access.md'),
        KB('Sales/archive/nested/old.md'),
        KB('Sales/archive/nested/older.md'),
        KB('Sales/archive/top.md'),
      ]);
      expect(await exists(KB('Sales/archive/access.md'))).toBe(false);
      expect(await exists(KB('Sales/archive'))).toBe(false);
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

    /**
     * The agent hears the sentence the sidebar shows — one refusal, named by
     * what is in the way, so a user reading a tool result and a user reading
     * the rename box are told the same thing.
     */
    it('a taken destination is refused with the one sentence, naming what is already there', async () => {
      const base = await seeded();
      await fs.writeFile(KB('Sales/notes.md'), '# Notes\n');
      await fs.writeFile(KB('Sales/report.docx'), 'docx bytes');

      const ontoFile = await call(base, 'move_file', { src: KB('Sales/report.docx'), dest: KB('Sales/notes.md') });
      expect(ontoFile.status).toBe(409);
      expect(ontoFile.body.error).toBe('A file named notes.md already exists in Sales.');
      expect(await fs.readFile(KB('Sales/notes.md'), { encoding: 'utf-8' })).toBe('# Notes\n');
      expect(await exists(KB('Sales/report.docx'))).toBe(true);

      // Onto a FOLDER of that name: the same sentence, said of a folder.
      const ontoFolder = await call(base, 'move_file', { src: KB('Sales/notes.md'), dest: KB('Sales/archive') });
      expect(ontoFolder.status).toBe(409);
      expect(ontoFolder.body.error).toBe('A folder named archive already exists in Sales.');
      expect(await exists(KB('Sales/archive/top.md'))).toBe(true);

      // A folder onto a file: named for what is in the way, not for what moves.
      const folderOntoFile = await call(base, 'move_file', { src: KB('Sales/archive'), dest: KB('Sales/notes.md') });
      expect(folderOntoFile.status).toBe(409);
      expect(folderOntoFile.body.error).toBe('A file named notes.md already exists in Sales.');
      expect(await fs.readFile(KB('Sales/notes.md'), { encoding: 'utf-8' })).toBe('# Notes\n');

      // The dry run says the same thing before anything is attempted.
      const dry = await call(base, 'move_file', { src: KB('Sales/report.docx'), dest: KB('Sales/notes.md'), dryRun: true });
      expect(dry.body).toMatchObject({ allowed: false, reason: 'A file named notes.md already exists in Sales.' });
    });

    it('copy_file refuses a taken destination with the same sentence, and copies nothing', async () => {
      const base = await seeded();
      await fs.writeFile(KB('Sales/notes.md'), '# Notes\n');

      const onto = await call(base, 'copy_file', { src: KB('Sales/deal.md'), dest: KB('Sales/notes.md') });
      expect(onto.status).toBe(409);
      expect(onto.body.error).toBe('A file named notes.md already exists in Sales.');
      expect(await fs.readFile(KB('Sales/notes.md'), { encoding: 'utf-8' })).toBe('# Notes\n');

      const ontoFolder = await call(base, 'copy_file', { src: KB('Sales/deal.md'), dest: KB('Sales/archive') });
      expect(ontoFolder.status).toBe(409);
      expect(ontoFolder.body.error).toBe('A folder named archive already exists in Sales.');

      // A free name still copies, exactly as before.
      const free = await call(base, 'copy_file', { src: KB('Sales/deal.md'), dest: KB('Sales/deal-copy.md') });
      expect(free.status).toBe(200);
      expect(await fs.readFile(KB('Sales/deal-copy.md'), { encoding: 'utf-8' })).toBe('deal');
    });

    // Only where the two spellings are distinct entries: on a case-insensitive
    // disk `link(deal.md, Deal.md)` is EEXIST at setup, and the case-only
    // rename it stands in for is covered by the service's own suite.
    it.skipIf(!caseSensitiveDisk)('a hard link under a case-variant name is still a second entry, so still a clash', async () => {
      // The one destination a move may land on is the source ITSELF, which is
      // what a case-insensitive disk shows for `deal.md` → `Deal.md`. This
      // disk is not that: `Deal.md` is a directory entry of its own, hard link
      // or no hard link, and a move onto it would take that name away. One
      // inode does not make it the same name — the folder listing does, and
      // here the folder lists both.
      const base = await seeded();
      await link(join(tempDir, KB('Sales/deal.md')), join(tempDir, KB('Sales/Deal.md')));

      const run = await call(base, 'move_file', { src: KB('Sales/deal.md'), dest: KB('Sales/Deal.md') });
      expect(run.status).toBe(409);
      expect(run.body.error).toBe('A file named Deal.md already exists in Sales.');
      expect(await exists(KB('Sales/Deal.md'))).toBe(true);
      expect(await exists(KB('Sales/deal.md'))).toBe(true);

      const copied = await call(base, 'copy_file', { src: KB('Sales/Deal.md'), dest: KB('Sales/deal.md') });
      expect(copied.status).toBe(409);
    });

    it.skipIf(!caseSensitiveDisk)('a hard link under an unrelated name is a clash, inode or no inode', async () => {
      // The same reading, without the case-variance to confuse it: two names
      // a user can see separately, and moving onto the second one would take
      // it away.
      const base = await seeded();
      await link(join(tempDir, KB('Sales/deal.md')), join(tempDir, KB('Sales/twin.md')));

      const run = await call(base, 'move_file', { src: KB('Sales/deal.md'), dest: KB('Sales/twin.md') });
      expect(run.status).toBe(409);
      expect(run.body.error).toBe('A file named twin.md already exists in Sales.');
      expect(await exists(KB('Sales/twin.md'))).toBe(true);
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

describe('a write refused for permissions says whether and how to propose it', () => {
  const TARGET = 'target-company-state';
  const DENIED = `${KB_DIR}/Sales/deal.md`;
  const KEY = 'hx_live_Zm9vYmFyU2VjcmV0S2V5';
  const SECRET_CONTENT = 'password=hunter2-do-not-echo';

  it('the suggested change-request title fits the limit and never splits an emoji', () => {
    const lead = 'Propose a change to ';
    expect(proposalTitleFor('Sales/deal.md')).toBe(`${lead}Sales/deal.md`);
    // The emoji's high surrogate lands on the 255th unit, the last one kept before the ellipsis.
    const path = `${'a'.repeat(254 - lead.length)}😀${'b'.repeat(40)}`;
    const title = proposalTitleFor(path);
    expect(title).toBe(`${lead}${'a'.repeat(254 - lead.length)}…`);
    expect(title.length).toBeLessThanOrEqual(256);
    expect(title).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  /** Access control whose read verdict is `readable` and which records every call. */
  const readVerdict = (readable: boolean | 'throws') => {
    const calls: string[] = [];
    const ac = {
      canRead: async (_w: string, _u: string, rel: string) => {
        calls.push(rel);
        if (readable === 'throws') throw new Error('git failed');
        return readable;
      },
      canReadBatch: async (_w: string, _u: string, paths: string[]) => new Map(paths.map((p) => [p, true])),
      // The move/delete preflight asks these before it ever reaches the
      // filesystem. `canWriteBatchAtRef` answering null is "no rules resolve
      // at HEAD", so the preflight blocks nothing and the refusal comes from
      // the lock gate below — which is the denial these tests are about.
      canWrite: async () => true,
      canDownload: async () => true,
      canOwner: async () => true,
      canWriteBatchAtRef: async () => null,
      eligibleWritersAtRef: async () => ({ roles: ['Sales Lead'], users: [{ name: 'Owner', email: 'owner@x' }] }),
    } as unknown as IAccessControl;
    return { ac, calls };
  };

  /** Make every mutating filesystem method refuse like the lock gate on a protected branch. */
  const denyWrites = (message?: string) => {
    const refuse = async (p?: unknown) => {
      const err = new AccessDeniedError({
        path: typeof p === 'string' ? p : DENIED,
        eligibleRoles: ['Sales Lead'],
        eligibleUsers: [{ name: 'Owner', email: 'owner@x' }],
      });
      if (message) Object.defineProperty(err, 'message', { value: message });
      throw err;
    };
    const target = fs as unknown as Record<string, unknown>;
    for (const m of ['writeFile', 'deleteFile', 'moveFile', 'mkdir']) target[m] = refuse;
    target.copyFile = async (_src: string, dest: string) => refuse(dest);
    target.writeFiles = async (writes: { path: string }[]) => refuse(writes[0]?.path);
  };

  const call = async (base: string, tool: string, body: Record<string, unknown>) => {
    const res = await fetch(`${base}/api/agent/tools/${tool}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a JSON body read field by field
    return { status: res.status, text, json: JSON.parse(text) as Record<string, any> };
  };

  const CALLS: Array<[string, Record<string, unknown>]> = [
    // The denied path already exists, so the writes say they mean to replace
    // it: the mode gate is not what these tests are about.
    ['write_file', { branch: TARGET, path: DENIED, content: SECRET_CONTENT, mode: 'overwrite' }],
    ['write_files', { branch: TARGET, files: [{ path: DENIED, content: SECRET_CONTENT }], mode: 'overwrite' }],
    ['edit_file', { branch: TARGET, path: DENIED, old_string: 'old', new_string: SECRET_CONTENT }],
    ['move_file', { branch: TARGET, src: DENIED, dest: `${KB_DIR}/Sales/moved.md` }],
    ['delete_file', { branch: TARGET, path: DENIED }],
    ['copy_file', { branch: TARGET, src: `${KB_DIR}/a.md`, dest: DENIED }],
    ['mkdir', { branch: TARGET, path: DENIED }],
  ];

  /**
   * A copy onto a name that is TAKEN is refused for the name, before any
   * permission is read (as a move is) — so the case that is about the
   * permission gives it a free destination. Every other tool here acts on the
   * file at `DENIED` and needs it present.
   */
  const freeDestinationFor = async (tool: string) => {
    if (tool === 'copy_file') await rm(join(tempDir, DENIED), { force: true });
  };

  it.each(CALLS)('%s: a reader gets canPropose and the three steps, and nothing is created', async (tool, body) => {
    const { ac, calls } = readVerdict(true);
    const base = await start('write', ac);
    await fs.mkdir(`${KB_DIR}/Sales`, { recursive: true });
    await fs.writeFile(DENIED, 'old text\n');
    await freeDestinationFor(tool);
    denyWrites();
    const workflowCalls = workspacePathCalls.length;

    const { status, json } = await call(base, tool, body);

    expect(status).toBe(403);
    expect(json).toMatchObject({
      kind: 'write-denied',
      path: DENIED,
      reason: 'Eligible: Sales Lead; Owner <owner@x>.',
      canPropose: true,
    });
    expect(json.cannotProposeReason).toBeUndefined();
    expect(json.error).toContain('You may propose this change instead');
    const draft = json.proposal.draftBranch as string;
    expect(json.proposal.targetBranch).toBe(TARGET);
    expect(json.proposal.steps.map((s: { tool: string }) => s.tool)).toEqual(['create_branch', tool, 'open_change_request']);
    expect(json.proposal.steps[0].args).toEqual({ name: draft, branch: TARGET });
    expect(json.proposal.steps[1].args).toEqual({ branch: draft });
    // Every argument open_change_request requires is present, so the step works as given.
    expect(json.proposal.steps[2].args).toEqual({ sourceBranch: draft, targetBranch: TARGET, title: 'Propose a change to Sales/deal.md' });
    // The read verdict was asked of the repo-relative path.
    expect(calls).toContain('Sales/deal.md');
    // Nothing was created: no workspace was resolved for the DRAFT the answer
    // suggests, and the context's workflow service is an empty stub, so a
    // create_branch or change request would have 500d. (The tools that
    // preflight do resolve the CALLER's own workspace on the way — to read
    // the on-disk spelling and refuse links — which is not a draft.)
    const forDraft = workspacePathCalls
      .slice(workflowCalls)
      .filter((b) => b.includes(draft) || b.includes(encodeURIComponent(draft)));
    expect(forDraft).toEqual([]);
  });

  it('the suggested draft is a branch the caller owns, for an address the convention rewrites', async () => {
    // `john.doe@` is the common corporate shape, and the one that catches a
    // prefix derived by a second spelling of the rule: the platform judges
    // authorship on `john-doe/`, so a suggested `john.doe/…` would be a draft
    // the agent creates, proposes from, and is then refused permission to
    // delete. Asserted through the platform's own predicate, not the regex.
    const email = 'John.Doe+kb@example.com';
    const { ac } = readVerdict(true);
    const base = await start('write', ac, email);
    denyWrites();

    const { json } = await call(base, 'write_file', CALLS[0][1]);

    const draft = json.proposal.draftBranch as string;
    expect(isBranchAuthoredBy(draft, email)).toBe(true);
    expect(draft).toBe('john-doe-kb/propose-deal');
    // The step the agent actually runs carries that same name.
    expect(json.proposal.steps[0].args).toEqual({ name: draft, branch: TARGET });
  });

  it('an address with no usable localpart is given a draft under its own suggestions prefix, still one it owns', async () => {
    // `branchAuthorLocalpart` answers null for a local part with no letter or
    // digit, rather than inventing an identity. The draft must still be one
    // the caller can later delete, so it comes from the second authorship
    // convention — keyed by user id — and is judged by that convention's own
    // predicate, as the branch-delete path judges it.
    const email = '+++@example.com';
    const { ac } = readVerdict(true);
    const base = await start('write', ac, email);
    denyWrites();

    const { json } = await call(base, 'write_file', CALLS[0][1]);

    const draft = json.proposal.draftBranch as string;
    expect(isBranchAuthoredBy(draft, email)).toBe(false);
    expect(isOwnSuggestionsBranch(draft, { email, id: 'u' })).toBe(true);
    expect(draft.startsWith('suggestions/')).toBe(true);
    expect(draft.endsWith('/propose-deal')).toBe(true);
  });

  it('without read access the denial says so in one sentence and offers no proposal', async () => {
    const { ac } = readVerdict(false);
    const base = await start('write', ac);
    denyWrites();
    const { status, json } = await call(base, 'write_file', CALLS[0][1]);
    expect(status).toBe(403);
    expect(json).toMatchObject({ kind: 'write-denied', path: DENIED, canPropose: false });
    expect(json.proposal).toBeUndefined();
    expect(json.cannotProposeReason).toBe('Proposing is not available: you cannot read this path.');
    expect(json.error).toContain('you cannot read this path');
  });

  it('on a branch that takes no change requests the denial says the branch is not proposable', async () => {
    const { ac } = readVerdict(true);
    const base = await start('write', ac);
    denyWrites();
    const { json } = await call(base, 'write_file', { ...CALLS[0][1], branch: 'someone/draft' });
    expect(json).toMatchObject({ kind: 'write-denied', canPropose: false });
    expect(json.cannotProposeReason).toContain('not a branch that accepts change requests');
  });

  it('fails closed when the read verdict cannot be reached', async () => {
    const { ac } = readVerdict('throws');
    const base = await start('write', ac);
    denyWrites();
    const { json } = await call(base, 'write_file', CALLS[0][1]);
    expect(json).toMatchObject({ kind: 'write-denied', canPropose: false });
    expect(json.proposal).toBeUndefined();
  });

  it('carries the excluded-principal sentence as the reason when the refusal gives one', async () => {
    const { ac } = readVerdict(true);
    const base = await start('write', ac);
    denyWrites(`You don't have permission to write to "${DENIED}". The Sales role is excluded at this folder.`);
    const { json } = await call(base, 'write_file', CALLS[0][1]);
    expect(json.reason).toBe('The Sales role is excluded at this folder.');
  });

  it('never echoes the key, the content or the session id', async () => {
    const { ac } = readVerdict(true);
    const base = await start('write', ac);
    await fs.mkdir(`${KB_DIR}/Sales`, { recursive: true });
    await fs.writeFile(DENIED, 'old text\n');
    denyWrites();
    for (const [tool, body] of CALLS) {
      await freeDestinationFor(tool);
      const { text } = await call(base, tool, { ...body, sessionId: 'sess-secret-123' });
      expect(text, tool).toContain('write-denied');
      for (const secret of [KEY, SECRET_CONTENT, 'sess-secret-123', 'Bearer']) expect(text, tool).not.toContain(secret);
    }
  });

  it('other failures pass through unchanged', async () => {
    const base = await start('write', readVerdict(true).ac);
    const res = await call(base, 'edit_file', { branch: TARGET, path: 'a.md', old_string: 'nope', new_string: 'x' });
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: 'old_string not found in the file.' });
  });

  it('each write tool mentions the proposal route in its description; read tools do not', async () => {
    await start();
    const tools = await toolRegistry.listInternal();
    for (const name of ['write_file', 'edit_file', 'write_files', 'move_file', 'delete_file', 'copy_file', 'mkdir']) {
      expect(tools.find((t) => t.name === name)?.description, name).toContain(PROPOSAL_ROUTE_NOTE.trim());
    }
    for (const name of ['read_file', 'grep', 'list_files']) {
      expect(tools.find((t) => t.name === name)?.description, name).not.toContain(PROPOSAL_ROUTE_NOTE.trim());
    }
  });
});

/**
 * A path with nothing at it is an ordinary answer, not a server failure.
 *
 * Every file tool used to reach that conclusion its own way — `file_stat`,
 * `grep` and `move_file` with a 404 of their own wording, the rest by letting
 * the filesystem's `ENOENT` escape as a 500 — so an agent could not tell "your
 * path is wrong" from "this deployment is broken". These tests pin ONE answer
 * for all of them: 404, `kind: 'not_found'`, the requested path echoed back,
 * and the one next-step sentence.
 *
 * The four path kinds each tool is asked about: never existed, cannot be read,
 * deleted on this branch, and malformed.
 */
describe('a path with nothing at it answers 404 not_found on every file tool', () => {
  const FOLDER = `${KB_DIR}/Knowledge`;
  const MISSING = `${FOLDER}/NoSuchFile.md`;

  /** Every file tool the ticket names, called against `path` / `src`. */
  const callsFor = (path: string): [string, Record<string, unknown>][] => [
    ['read_file', { path }],
    ['file_stat', { path }],
    ['grep', { pattern: 'anything', path }],
    ['edit_file', { path, old_string: 'a', new_string: 'b' }],
    ['delete_file', { path }],
    ['move_file', { src: path, dest: `${FOLDER}/Moved.md` }],
    ['copy_file', { src: path, dest: `${FOLDER}/Copied.md` }],
    ['unzip', { path: `${path}.zip` }],
  ];

  /** The one answer, asserted the same way for every tool. */
  async function expectNotFound(base: string, tool: string, body: Record<string, unknown>, named: string): Promise<void> {
    const res = await post(`${base}/api/agent/tools/${tool}`, { branch: 'main', ...body });
    const json = (await res.json()) as { error?: string; kind?: string; path?: string };
    expect(res.status, `${tool} status`).toBe(404);
    expect(json.kind, `${tool} kind`).toBe('not_found');
    expect(json.path, `${tool} path`).toBe(named);
    expect(json.error, `${tool} message`).toContain(`"${named}"`);
    expect(json.error, `${tool} next step`).toContain(NOT_FOUND_NEXT_STEP);
  }

  it('a path that never existed', async () => {
    const base = await start();
    await fs.mkdir(FOLDER, { recursive: true });
    for (const [tool, body] of callsFor(MISSING)) {
      // unzip is asked about `<path>.zip`, so it names that path, not MISSING.
      await expectNotFound(base, tool, body, (body.path as string) ?? (body.src as string));
    }
  });

  it('a file deleted on this branch', async () => {
    const base = await start();
    const gone = `${FOLDER}/Gone.md`;
    await fs.mkdir(FOLDER, { recursive: true });
    await fs.writeFile(gone, 'here for now\n');
    await fs.writeFile(`${gone}.zip`, 'not really a zip');
    expect((await post(`${base}/api/agent/tools/delete_file`, { branch: 'main', path: gone })).status).toBe(200);
    await fs.deleteFile(`${gone}.zip`);
    for (const [tool, body] of callsFor(gone)) {
      await expectNotFound(base, tool, body, (body.path as string) ?? (body.src as string));
    }
  });

  // ENOTDIR, not ENOENT: nothing can live under a FILE, so the path is as
  // absent as a name nobody used — and the raw errno used to escape as a 500
  // carrying the server's own absolute path in its message.
  it('a path whose parent segment is a file', async () => {
    const base = await start();
    await fs.mkdir(FOLDER, { recursive: true });
    await fs.writeFile(`${FOLDER}/Note.md`, 'a real file\n');
    const under = `${FOLDER}/Note.md/nested.md`;
    for (const [tool, body] of callsFor(under)) {
      await expectNotFound(base, tool, body, (body.path as string) ?? (body.src as string));
    }
  });

  // A copy has TWO ends and the filesystem blames the source for both: it
  // re-throws every ENOENT as `FileNotFoundError(src)`, and a destination
  // segment that is a file escapes raw as ENOTDIR from the parent mkdir. With
  // the source sitting right there, the absence can only be the destination's
  // — so the 404 names the destination. It must not be left to escape as a
  // 500 either: that is the answer whose message carries the server's own
  // absolute path, and a mis-spelled destination is the caller's to fix.
  it('copy_file names the DESTINATION when the source is there and the destination is not', async () => {
    const base = await start('write');
    await fs.mkdir(FOLDER, { recursive: true });
    await fs.writeFile(`${FOLDER}/Note.md`, 'a real file\n');
    await fs.writeFile(`${FOLDER}/Source.md`, 'copy me\n');
    const dest = `${FOLDER}/Note.md/deeper/copy.md`;
    const res = await post(`${base}/api/agent/tools/copy_file`, { branch: 'main', src: `${FOLDER}/Source.md`, dest });
    const json = (await res.json()) as { error?: string; kind?: string; path?: string };
    expect(res.status).toBe(404);
    expect(json.kind).toBe('not_found');
    expect(json.path).toBe(dest);
    expect(json.error).toContain(NOT_FOUND_NEXT_STEP);
    // The source is not what is wrong, and the answer never says it is.
    expect(json.error).not.toContain('Source.md');
    // Nor does the raw errno — and the server's own absolute path with it —
    // reach the caller, which is what the old 500 handed over.
    expect(json.error).not.toContain('ENOTDIR');
  });

  // A backslash is a filename character on this disk, never a separator, so
  // the read tools meet plain absence. move_file and delete_file judge the
  // path as WRITTEN and keep refusing it up front — an answer that predates
  // this mapping and is not absence at all.
  it('a malformed path: backslashes read as absence, and still refused by the tools that judge spelling', async () => {
    const base = await start();
    const odd = `${KB_DIR}\\Knowledge\\NoSuchFile.md`;
    for (const tool of ['read_file', 'file_stat', 'grep', 'edit_file', 'copy_file'] as const) {
      const body = callsFor(odd).find(([name]) => name === tool)![1];
      await expectNotFound(base, tool, body, odd);
    }
    for (const [tool, body] of [
      ['delete_file', { path: odd }],
      ['move_file', { src: odd, dest: `${FOLDER}/Moved.md` }],
    ] as [string, Record<string, unknown>][]) {
      const res = await post(`${base}/api/agent/tools/${tool}`, { branch: 'main', ...body });
      expect(res.status, tool).toBe(400);
      expect((await res.json()).error, tool).toContain('backslashes');
    }
  });

  // THE ordering rule: the read gate answers before absence does. A caller who
  // may not read a path must not learn from the answer whether anything is
  // there — so a missing denied path and an existing denied one are the SAME
  // response, byte for byte.
  it('a path the caller may not read answers the denial, never 404', async () => {
    const base = await start('write', denyReads(new Set(['Knowledge/Secret.md', 'Knowledge/Ghost.md'])));
    await fs.mkdir(FOLDER, { recursive: true });
    await fs.writeFile(`${FOLDER}/Secret.md`, 'real content\n');
    for (const tool of ['read_file', 'file_stat', 'grep'] as const) {
      const ask = async (name: string): Promise<{ status: number; body: string }> => {
        const body = callsFor(`${FOLDER}/${name}`).find(([t]) => t === tool)![1];
        const res = await post(`${base}/api/agent/tools/${tool}`, { branch: 'main', ...body });
        return { status: res.status, body: (await res.text()).replace(name, '<name>') };
      };
      const present = await ask('Secret.md');
      const absent = await ask('Ghost.md');
      expect(present.status, tool).toBe(403);
      expect(absent, tool).toEqual(present);
      expect(absent.body, tool).not.toContain('not_found');
    }
  });

  // The same ordering rule on the WRITE side. A refusal to write must not
  // report what is on disk, or the refusal itself becomes the disclosure: a
  // caller who may not copy into a folder would learn from the answer whether
  // the source they named exists. So the write denial comes first and absence
  // is only asked about once the copy was allowed to be attempted — the 404
  // this ticket adds must not push in front of the 403 that was already there.
  it('copy_file refuses a denied destination with the write denial, even when the source is missing', async () => {
    const base = await start('write');
    await fs.mkdir(FOLDER, { recursive: true });
    const denied = async (src: string): Promise<{ status: number; body: string }> => {
      const copySpy = vi.spyOn(fs, 'copyFile').mockRejectedValue(
        new AccessDeniedError({ path: `${FOLDER}/Denied.md`, eligibleRoles: ['Owner'], eligibleUsers: [] }),
      );
      try {
        const res = await post(`${base}/api/agent/tools/copy_file`, { branch: 'main', src, dest: `${FOLDER}/Denied.md` });
        return { status: res.status, body: await res.text() };
      } finally {
        copySpy.mockRestore();
      }
    };
    await fs.writeFile(`${FOLDER}/Present.md`, 'here\n');
    const present = await denied(`${FOLDER}/Present.md`);
    const absent = await denied(MISSING);
    expect(present.status).toBe(403);
    // Byte for byte the same refusal: the source's existence changes nothing.
    expect(absent.status).toBe(403);
    expect(absent.body).toBe(present.body);
    expect(absent.body).toContain('write-denied');
    expect(absent.body).not.toContain('not_found');
  });

  // Absence is ENOENT and ENOTDIR and nothing else. A path that cannot be READ
  // is not a path the caller should be told to go and re-spell.
  it('a filesystem failure that is not absence stays a 500', async () => {
    const base = await start();
    await fs.mkdir(FOLDER, { recursive: true });
    const boom = Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO' });
    const readFileSpy = vi.spyOn(fs, 'readFile').mockRejectedValue(boom);
    try {
      const res = await post(`${base}/api/agent/tools/read_file`, { branch: 'main', path: `${FOLDER}/Unreadable.md` });
      expect(res.status).toBe(500);
      const json = (await res.json()) as { kind?: string };
      expect(json.kind).toBeUndefined();
    } finally {
      readFileSpy.mockRestore();
    }
  });
});
