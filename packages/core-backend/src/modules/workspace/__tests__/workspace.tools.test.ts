import type { Server as HttpServer } from 'node:http';
import { execFile } from 'node:child_process';
import { link, mkdir, mkdtemp, readdir as nodeReaddir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import AdmZip from 'adm-zip';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { testKbContext } from '../../../__tests__/kb-context.js';
import { LocalFilesystem } from '@mastra/core/workspace';
import { ToolRegistry } from '../../tool-registry/tool-registry.js';
import { createToolHandlerFactory } from '../../tool-helpers/tool-handler.js';
import { ToolError, type ToolContext } from '../../tool-helpers/tool.contract.js';
import type { ToolAuth } from '../../tool-auth/tool-auth.middleware.js';
import { registerWorkspaceTools } from '../workspace.tools.js';
import { sharedFileRules, sharedFileRulesSection } from '../../agent-instructions/shared-file-rules.js';
import { composeAgentGuide } from '../../agent-guide/agent-guide.js';
import { GUIDE_FIRST_SENTENCE } from '../../tool-registry/guide-first.js';
import { RoutineWritePolicyService } from '../routine-write-policy.js';
import { UuidSessionSink, type ISessionSink } from '../session-sink.js';
import { FIRST_RUN_SECTION_ID, STARTER_GUIDE_FILE, firstRunNote, type FirstRunStarterSource } from '../first-run.js';
import { WorkflowHooks, type AgentOperationContext } from '../../workflow/workflow-hooks.js';
import { SESSION_ID_DESCRIPTION, ToolDescriptionNotes } from '../agent-access.gate.js';
import { SpillStore } from '../spill-store.js';
import { DocExtractService } from '../file-readers/doc-extract.service.js';
import { OCTET_STREAM_FALLBACK_NOTE } from '../file-readers/content-mode.js';
import type { IAccessControl } from '../../access/access-control.interface.js';
import { AccessControlService } from '../../access/access-control.service.js';
import { NodeFs } from '../../kb-fs/node-fs.js';
import type { WorkspaceService } from '../workspace.service.js';
import { DEFAULT_KB_LAYOUT, isBranchAuthoredBy, isOwnSuggestionsBranch } from '@bevel-software/platform-shared';
import { assertValidBranchName } from '../../kb-fs/branch-name.js';
import { normalizeWorkspacePath } from '../../kb-fs/repo-path.js';
import { GIT_INTERNALS_MESSAGE, PathNotFoundError } from '../../../shared/domain-errors.js';
import { AccessDeniedError } from '../../access-model/access-errors.js';
import { proposalTitleFor } from '../write-denial.js';
import { NOT_FOUND_NEXT_STEP } from '../not-found.js';
import { compileCheck, exampleArguments } from '@bevel-software/platform-mcp-core';
import { routeToolSchemas } from '../../tool-helpers/route-tool-schemas.js';
import { TOOL_DESCRIPTION_CAP, clientVisibleLength } from '../../tool-registry/description-length.js';

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
  // The `after` half of a move's or copy's preview. Allowing everything here
  // keeps it the same answer as the four gates above; what the relocation of
  // a folder's `access.md` files actually does to it is exercised against
  // REAL rules in "a move preview judges the destination as it will be".
  previewAccessAfterRelocation: async () => ({ read: true, write: true, download: true, owner: true }),
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
/** Every `(archive, destination)` pair `unzip` handed the service. */
let unzipCalls: [string, string | undefined][] = [];
/**
 * Workspace-relative targets the `unzipFile` stand-in pretends the archive
 * holds. Empty by default (the stub extracts nothing); a test that is about
 * the per-entry write guard sets it, and the stand-in then runs the guard once
 * per entry the way the real service does — which is asserted where it lives,
 * in `workspace.service.test.ts`.
 */
let unzipEntries: string[] = [];
/** Every folder turn a tool took, as `workspaceId:dir`. */
let folderTurns: string[] = [];
/** The policy instance the tools were mounted with, so a test can restrict a session. */
let writePolicy: RoutineWritePolicyService;
/** What the platform's guide reads as, for the tests about the guide's name. */
let guideText = 'THE PLATFORM GUIDE\n';
/**
 * The focused branch the resolved `ToolContext` carries — mirrors the branch an
 * internal token bakes for the in-process agent. A test sets it to prove a
 * branch-less `execute_command` falls back to the session's own workspace.
 */
let focusedBranch: string | undefined;
/** The registry the tools were mounted into, so a test can inspect their defs. */
let toolRegistry: ToolRegistry;
/** The hook registry the tools were mounted against, so a test can register one. */
let hooks: WorkflowHooks;
/** The note registry the tools were mounted against, so a test can register a note. */
let notes: ToolDescriptionNotes;
/**
 * The recovery/merge bot's address, as the mounted gate knows it — the one
 * identity that never reaches a hook.
 */
const RECOVERY_BOT = 'recovery-bot@bevel.local';
/**
 * What the auth layer resolves this caller's source to. `internal` (the
 * in-process agent) unless a test is about a person in the app (`session`) or
 * an external agent.
 */
let callerSource: 'internal' | 'external' | 'session' = 'internal';
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
  hooks = new WorkflowHooks();
  notes = new ToolDescriptionNotes();
  callerSource = 'internal';
  tempDir = await mkdtemp(join(tmpdir(), 'ws-tools-'));
  docCacheDir = await mkdtemp(join(tmpdir(), 'ws-doc-cache-'));
  fs = new LocalFilesystem({ basePath: tempDir, contained: true });
  // The harness speaks the paths the TOOLS speak. A fixture written here as
  // `report.docx` must land where a tool asked for `report.docx` will read it:
  // inside the checkout, through the one normaliser. Before the normaliser
  // existed, this file's fixtures sat BESIDE the clone — the very bug the
  // ticket is about — and every test would otherwise have to restate the
  // prefix. Idempotent, so the tools' own already-prefixed paths pass through.
  for (const method of ['readFile', 'writeFile', 'appendFile', 'deleteFile', 'mkdir', 'stat'] as const) {
    const inner = (fs as unknown as Record<string, (...a: unknown[]) => unknown>)[method].bind(fs);
    (fs as unknown as Record<string, unknown>)[method] = (path: string, ...rest: unknown[]) =>
      inner(normalizeWorkspacePath(path, KB_DIR), ...rest);
  }
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
  // `LockingFilesystem.rewriteFile`: read, compute and write with the path
  // "locked". The other writer runs first — where the real filesystem would be
  // acquiring the lock — so `rewrite` reads what that writer left.
  (fs as unknown as Record<string, unknown>).rewriteFile = async (
    path: string,
    rewrite: (current: Buffer | null) => string | Promise<string>,
  ) => {
    await runRaceHook();
    // Absent is null; any other read failure is a failure, as in the real one.
    const current = await fs.readFile(path).then(
      (c) => (Buffer.isBuffer(c) ? c : Buffer.from(String(c), 'utf8')),
      (err: unknown) => {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') return null;
        throw err;
      },
    );
    return plainWriteFile(path, await rewrite(current));
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
  unzipCalls = [];
  unzipEntries = [];
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
      unzipFile: async (
        _id: string,
        zipRel: string,
        destRel?: string,
        guardWrite?: (wsRelativePath: string) => Promise<void>,
      ) => {
        // Recorded so a test can assert the PATHS the tool handed over — both
        // ends normalised into the repository.
        unzipCalls.push([zipRel, destRel]);
        try {
          await stat(join(tempDir, zipRel));
        } catch {
          throw new PathNotFoundError(zipRel);
        }
        const extracted: string[] = [];
        const skipped: { path: string; reason: string }[] = [];
        for (const entry of unzipEntries) {
          try {
            await guardWrite?.(entry);
            extracted.push(entry);
          } catch (err) {
            skipped.push({ path: entry, reason: err instanceof Error ? err.message : 'refused' });
          }
        }
        return { destination: '', extracted, skipped };
      },
    } as never,
    workflowService: {} as never,
    events: {} as never,
    getFilesystem: async () => fs,
  });
  const toolHandler = createToolHandlerFactory(resolve);
  const fakeAuth = (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.toolAuth = { source: callerSource, userId: 'u', scope };
    next();
  };
  const app = express();
  app.use(express.json());
  const router = express.Router();
  registerWorkspaceTools(registry, router, fakeAuth, toolHandler, new SpillStore(join(tmpdir(), 'bevel-test-spills')), new DocExtractService(docCacheDir), access, testKbContext({ kbDirName: KB_DIR }), {
    // The hooks and the notes a test registers against; with neither
    // registered (the default, and every Hexis-only deployment) the gate
    // refuses nothing and the descriptions say nothing extra.
    recoveryBotEmail: RECOVERY_BOT,
    hooks,
    notes,
  }, writePolicy, {} as never /* sessionSink — start_session not exercised here */, undefined, undefined, undefined, async () => guideText);
  app.use('/api', router);
  httpServer = await new Promise<HttpServer>((r) => {
    const s = app.listen(0, () => r(s));
  });
  return `http://127.0.0.1:${(httpServer.address() as { port: number }).port}`;
}

/** POST a body EXACTLY as given — for the tests about a malformed call. */
const postRaw = (url: string, body: unknown = {}) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer x' }, body: JSON.stringify(body) });

/**
 * POST a well-formed call. Every KB tool requires `branch` — a call that names
 * none is refused at the mount with 400 `branch-required` — so this names one
 * unless the test already did. A test ABOUT the missing input uses `postRaw`,
 * so the thing under test is never papered over by the helper. So does
 * `start_session`, which declares no arguments at all and forbids extras: its
 * route refuses a `branch` as an argument it does not have.
 */
const post = (url: string, body: unknown = {}) =>
  postRaw(
    url,
    body !== null && typeof body === 'object' && !Array.isArray(body) && !('branch' in body)
      ? { branch: 'main', ...body }
      : body,
  );

beforeEach(() => {
  /* fresh per test via start() */
  guideText = 'THE PLATFORM GUIDE\n';
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
    expect(await (await post(`${base}/api/agent/tools/read_file`, { path: `${KB_DIR}/a.md` })).json()).toEqual({ path: `${KB_DIR}/a.md`, content: 'hello\nworld\n' });
  });

  it('write_file then read_file round-trips', async () => {
    const base = await start();
    await post(`${base}/api/agent/tools/write_file`, { path: `${KB_DIR}/b.md`, content: 'fresh' });
    expect(await (await post(`${base}/api/agent/tools/read_file`, { path: `${KB_DIR}/b.md` })).json()).toMatchObject({ content: 'fresh' });
  });

  it('edit_file replaces an exact unique string', async () => {
    const base = await start();
    const res = await post(`${base}/api/agent/tools/edit_file`, { path: `${KB_DIR}/a.md`, old_string: 'world', new_string: 'earth' });
    expect(await res.json()).toMatchObject({ path: `${KB_DIR}/a.md`, replaced: 1 });
    expect(await (await post(`${base}/api/agent/tools/read_file`, { path: `${KB_DIR}/a.md` })).json()).toMatchObject({ content: 'hello\nearth\n' });
  });

  it('edit_file 400s when old_string is missing', async () => {
    const base = await start();
    expect((await post(`${base}/api/agent/tools/edit_file`, { path: `${KB_DIR}/a.md`, old_string: 'nope', new_string: 'x' })).status).toBe(400);
  });

  it('edit_file writes new_string exactly as sent, `$` patterns included', async () => {
    const base = await start();
    const res = await post(`${base}/api/agent/tools/edit_file`, { path: `${KB_DIR}/a.md`, old_string: 'world', new_string: "cost: $& $1 $' $$" });
    expect(res.status).toBe(200);
    expect(String(await fs.readFile(`${KB_DIR}/a.md`))).toBe("hello\ncost: $& $1 $' $$\n");
  });

  /**
   * An edit is a promise about the text it replaces, so that text has to be
   * found in the file as it is when the write lands — read with the path's
   * lock held, not at a preflight anybody may invalidate. `raceHook` is the
   * other writer, running exactly where the real filesystem acquires the lock.
   */
  describe('edit_file looks for old_string in the file the write actually lands on', () => {
    const EMPTY_OWNER = '# Assignee\n\n# Log';
    const claim = (base: string, who: string) =>
      post(`${base}/api/agent/tools/edit_file`, {
        path: `${KB_DIR}/ticket.md`,
        old_string: EMPTY_OWNER,
        new_string: `# Assignee\n${who}\n\n# Log`,
      });

    it('refuses when another writer replaced that text after the preflight, and keeps their write', async () => {
      const base = await start();
      await fs.writeFile(`${KB_DIR}/ticket.md`, '# Assignee\n\n# Log\n- filed\n');
      raceHook = async () => { await fs.writeFile(`${KB_DIR}/ticket.md`, '# Assignee\ncoder1\n\n# Log\n- filed\n'); };
      const res = await claim(base, 'coder2');
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain('old_string not found');
      expect(String(await fs.readFile(`${KB_DIR}/ticket.md`))).toBe('# Assignee\ncoder1\n\n# Log\n- filed\n');
    });

    it('applies the edit to what the other writer left when the text is still there', async () => {
      const base = await start();
      await fs.writeFile(`${KB_DIR}/ticket.md`, '# Assignee\n\n# Log\n- filed\n');
      raceHook = async () => { await fs.writeFile(`${KB_DIR}/ticket.md`, '# Assignee\n\n# Log\n- filed\n- a line added meanwhile\n'); };
      const res = await claim(base, 'coder2');
      expect(res.status).toBe(200);
      // Their line is kept: the new content was computed from the file as it was under the lock.
      expect(String(await fs.readFile(`${KB_DIR}/ticket.md`))).toBe('# Assignee\ncoder2\n\n# Log\n- filed\n- a line added meanwhile\n');
    });

    it('refuses when the text became ambiguous after the preflight', async () => {
      const base = await start();
      await fs.writeFile(`${KB_DIR}/ticket.md`, '# Assignee\n\n# Log\n- filed\n');
      raceHook = async () => { await fs.writeFile(`${KB_DIR}/ticket.md`, `${EMPTY_OWNER}\n${EMPTY_OWNER}\n`); };
      const res = await claim(base, 'coder2');
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain('appears 2 times');
      expect(String(await fs.readFile(`${KB_DIR}/ticket.md`))).toBe(`${EMPTY_OWNER}\n${EMPTY_OWNER}\n`);
    });

    it('answers not found when the file was deleted after the preflight, and does not recreate it', async () => {
      const base = await start();
      await fs.writeFile(`${KB_DIR}/ticket.md`, '# Assignee\n\n# Log\n- filed\n');
      raceHook = async () => { await fs.deleteFile(`${KB_DIR}/ticket.md`); };
      const res = await claim(base, 'coder2');
      expect(res.status).toBe(404);
      await expect(fs.readFile(`${KB_DIR}/ticket.md`)).rejects.toThrow();
    });

    // Every question the tool asks of the file is asked of the bytes it is
    // about to replace. An extensionless file may hold anything, and the app's
    // own upload can swap it for a binary between the preflight and the lock.
    // The binary still CONTAINS `old_string` here, so nothing but the
    // "may these bytes be edited as text" question can refuse it.
    it('refuses when the file became binary after the preflight, and leaves those bytes alone', async () => {
      const base = await start();
      await fs.writeFile(`${KB_DIR}/TICKET`, '# Assignee\n\n# Log\n- filed\n');
      const binary = Buffer.concat([Buffer.from([0x00, 0xff, 0xfe, 0x00]), Buffer.from(`${EMPTY_OWNER}\n`, 'utf8')]);
      raceHook = async () => { await fs.writeFile(`${KB_DIR}/TICKET`, binary); };
      const res = await post(`${base}/api/agent/tools/edit_file`, {
        path: `${KB_DIR}/TICKET`,
        old_string: EMPTY_OWNER,
        new_string: '# Assignee\ncoder2\n\n# Log',
      });
      expect(res.status).toBe(415);
      expect(await res.json()).toMatchObject({ kind: 'binary_not_writable' });
      const after = await fs.readFile(`${KB_DIR}/TICKET`);
      expect(Buffer.from(after as Buffer).equals(binary)).toBe(true);
    });

    it('counts replace_all over the file as it is under the lock', async () => {
      const base = await start();
      await fs.writeFile(`${KB_DIR}/ticket.md`, 'x x\n');
      raceHook = async () => { await fs.writeFile(`${KB_DIR}/ticket.md`, 'x x x\n'); };
      const res = await post(`${base}/api/agent/tools/edit_file`, { path: `${KB_DIR}/ticket.md`, old_string: 'x', new_string: 'y', replace_all: true });
      expect(await res.json()).toMatchObject({ replaced: 3 });
      expect(String(await fs.readFile(`${KB_DIR}/ticket.md`))).toBe('y y y\n');
    });
  });

  it('list_files + file_stat', async () => {
    const base = await start();
    const root = (await (await post(`${base}/api/agent/tools/list_files`, {})).json()) as { entries: { name: string }[] };
    // The workspace root holds the checkout and nothing else now.
    expect(root.entries.map((e) => e.name)).toEqual([KB_DIR]);
    const list = (await (await post(`${base}/api/agent/tools/list_files`, { path: KB_DIR })).json()) as { entries: { name: string }[] };
    expect(list.entries.map((e) => e.name)).toContain('a.md');
    expect(await (await post(`${base}/api/agent/tools/file_stat`, { path: `${KB_DIR}/a.md` })).json()).toMatchObject({ type: 'file' });
  });

  it('grep finds a match with line number', async () => {
    const base = await start();
    const res = (await (await post(`${base}/api/agent/tools/grep`, { pattern: 'wor' })).json()) as { matches: { path: string; line: number }[] };
    expect(res.matches).toContainEqual(expect.objectContaining({ path: `${KB_DIR}/a.md`, line: 2 }));
  });

  // Copy path gives the root-anchored `/<kbDirName>/…`, and people paste
  // that same text into an agent: a leading slash names the same path.
  it('every path input accepts a leading slash as the same workspace path', async () => {
    const base = await start();
    expect(await (await post(`${base}/api/agent/tools/read_file`, { path: `/${KB_DIR}/a.md` })).json()).toEqual({ path: `${KB_DIR}/a.md`, content: 'hello\nworld\n' });
    expect(await (await post(`${base}/api/agent/tools/file_stat`, { path: `/${KB_DIR}/a.md` })).json()).toMatchObject({ type: 'file' });
    await post(`${base}/api/agent/tools/write_file`, { path: `/${KB_DIR}/b.md`, content: 'fresh' });
    await post(`${base}/api/agent/tools/write_file`, { path: `/${KB_DIR}/c.md`, content: 'batch' });
    await post(`${base}/api/agent/tools/edit_file`, { path: `/${KB_DIR}/a.md`, old_string: 'world', new_string: 'earth' });
    await post(`${base}/api/agent/tools/mkdir`, { path: `/${KB_DIR}/dir` });
    await post(`${base}/api/agent/tools/copy_file`, { src: `/${KB_DIR}/b.md`, dest: `/${KB_DIR}/dir/b-copy.md` });
    await post(`${base}/api/agent/tools/move_file`, { src: `/${KB_DIR}/c.md`, dest: `/${KB_DIR}/dir/c.md` });
    expect(await readFile(join(tempDir, `${KB_DIR}/a.md`), 'utf8')).toBe('hello\nearth\n');
    expect(await readFile(join(tempDir, `${KB_DIR}/b.md`), 'utf8')).toBe('fresh');
    expect(await readFile(join(tempDir, KB_DIR, 'dir', 'b-copy.md'), 'utf8')).toBe('fresh');
    expect(await readFile(join(tempDir, KB_DIR, 'dir', 'c.md'), 'utf8')).toBe('batch');
    const list = (await (await post(`${base}/api/agent/tools/list_files`, { path: `/${KB_DIR}/dir` })).json()) as { path: string; entries: { name: string }[] };
    expect(list.path).toBe(`${KB_DIR}/dir`);
    expect(list.entries.map((e) => e.name).sort()).toEqual(['b-copy.md', 'c.md']);
    const grep = (await (await post(`${base}/api/agent/tools/grep`, { pattern: 'earth', path: `/${KB_DIR}/a.md` })).json()) as { matches: { path: string }[] };
    expect(grep.matches).toContainEqual(expect.objectContaining({ path: `${KB_DIR}/a.md` }));
    await post(`${base}/api/agent/tools/delete_file`, { path: `/${KB_DIR}/b.md` });
    await expect(readFile(join(tempDir, `${KB_DIR}/b.md`), 'utf8')).rejects.toThrow();
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

  // The routes meet this rule inside WorkspaceService; the tools write through
  // the locking filesystem, which never enters it — so the rule has to hold on
  // this surface on its own, or `write_file` could create the one folder no
  // single-prefix path can name.
  it('the checkout folder name is reserved at the repository root on the tool surface too', async () => {
    const base = await start();
    const reserved = `${KB_DIR}/${KB_DIR}`;
    const refused = async (tool: string, body: Record<string, unknown>) => {
      const res = await post(`${base}/api/agent/tools/${tool}`, body);
      expect(res.status, tool).toBe(400);
      expect(JSON.stringify(await res.json()), tool).toContain('is reserved');
    };
    await refused('write_file', { path: `${reserved}/x.md`, content: 'x' });
    await refused('write_files', { files: [{ path: `${KB_DIR}/ok.md`, content: 'ok' }, { path: `${reserved}/y.md`, content: 'y' }] });
    await refused('mkdir', { path: reserved });
    await refused('copy_file', { src: `${KB_DIR}/a.md`, dest: `${reserved}/a.md` });
    await refused('move_file', { src: `${KB_DIR}/a.md`, dest: `${reserved}/a.md` });
    await refused('edit_file', { path: `${reserved}/x.md`, old_string: 'a', new_string: 'b' });
    // `unzip` names its target under `destination`, the one key that is not
    // `path`, `dest` or `files` — refused before any archive is looked at.
    await refused('unzip', { path: `${KB_DIR}/archive.zip`, destination: reserved });
    // Nothing landed — the batch's valid entry included, since the batch was
    // refused as a whole before any write.
    await expect(stat(join(tempDir, reserved))).rejects.toThrow();
    await expect(stat(join(tempDir, KB_DIR, 'ok.md'))).rejects.toThrow();

    // An existing reserved folder (an older build could have made one) can
    // still be emptied and moved out of: the rule is about creating, not about
    // trapping what is there.
    await mkdir(join(tempDir, reserved), { recursive: true });
    await writeFile(join(tempDir, reserved, 'old.md'), 'old');
    await writeFile(join(tempDir, reserved, 'keep.md'), 'keep');
    expect((await post(`${base}/api/agent/tools/move_file`, { src: `${reserved}/keep.md`, dest: `${KB_DIR}/keep.md` })).status).toBe(200);
    expect((await post(`${base}/api/agent/tools/delete_file`, { path: `${reserved}/old.md` })).status).toBe(200);
    expect(await readFile(join(tempDir, KB_DIR, 'keep.md'), 'utf8')).toBe('keep');
  });

  it('grep with no path searches the repository, never what sits beside the checkout', async () => {
    const base = await start();
    // A stray an older build left beside the checkout. The read gate has no
    // rules for a path outside the repository and would call it readable, so
    // the only safe root for a walk is the repository itself.
    await writeFile(join(tempDir, 'stray.md'), 'needle in a stray\n');
    await post(`${base}/api/agent/tools/write_file`, { path: `${KB_DIR}/n.md`, content: 'needle in the repository\n' });
    const res = (await (await post(`${base}/api/agent/tools/grep`, { pattern: 'needle' })).json()) as { matches: { path: string }[] };
    expect(res.matches.map((m) => m.path)).toEqual([`${KB_DIR}/n.md`]);
    // An explicit empty path is the same absence, not a spelling of the
    // workspace directory.
    const empty = (await (await post(`${base}/api/agent/tools/grep`, { pattern: 'needle', path: '' })).json()) as { matches: { path: string }[] };
    expect(empty.matches.map((m) => m.path)).toEqual([`${KB_DIR}/n.md`]);
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
    // `postRaw`: the absent field IS the test here, so the body goes as written.
    const res = await postRaw(`${base}/api/agent/tools/execute_command`, { command: 'echo should-not-run' });
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
    const res = (await (await postRaw(`${base}/api/agent/tools/execute_command`, { command: 'echo hello-exec' })).json()) as { stdout: string; exitCode: number };
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

  it('answers a branch-less call with the same kind every other KB tool uses', async () => {
    const base = await start();
    // The MESSAGE here is this tool's own — only `execute_command` has a
    // focused-branch fallback to explain. The DISCRIMINATOR is shared, so a
    // client switches on one kind across the whole surface instead of matching
    // prose per tool.
    for (const body of [{ command: 'x' }, { branch: '', command: 'x' }, { branch: 'undefined', command: 'x' }]) {
      const res = await postRaw(`${base}/api/agent/tools/execute_command`, body);
      expect(res.status).toBe(400);
      expect((await res.json()).kind).toBe('branch-required');
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
    expect((await post(`${base}/api/agent/tools/write_file`, { path: `${KB_DIR}/c.md`, content: 'x' })).status).toBe(403);
    expect((await post(`${base}/api/agent/tools/read_file`, { path: `${KB_DIR}/a.md` })).status).toBe(200);
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
    const res = await writeFile(base, { path: `${KB_DIR}/fresh.md`, content: 'new page' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ path: `${KB_DIR}/fresh.md`, bytes: 8, outcome: 'created' });
    expect(await onDisk(`${KB_DIR}/fresh.md`)).toBe('new page');
  });

  it('write_file with no mode refuses a path that exists, names it, says how to replace it, and leaves it alone', async () => {
    const base = await start();
    const res = await writeFile(base, { path: `${KB_DIR}/a.md`, content: 'clobbered' });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; code: string; path: string };
    expect(body.code).toBe('exists');
    expect(body.path).toBe(`${KB_DIR}/a.md`);
    expect(body.error).toContain(`${KB_DIR}/a.md`);
    expect(body.error).toContain('pass mode: overwrite to replace it');
    expect(await onDisk(`${KB_DIR}/a.md`)).toBe('hello\nworld\n');
  });

  it('write_file mode overwrite replaces and says `replaced`, and creates what is not there yet', async () => {
    const base = await start();
    const replaced = await writeFile(base, { path: `${KB_DIR}/a.md`, content: 'replacement' });
    expect(replaced.status).toBe(409); // …without the mode.
    const res = await writeFile(base, { path: `${KB_DIR}/a.md`, content: 'replacement', mode: 'overwrite' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ path: `${KB_DIR}/a.md`, outcome: 'replaced' });
    expect(await onDisk(`${KB_DIR}/a.md`)).toBe('replacement');
    // `overwrite` on a path with nothing at it is still a create, and says so.
    const created = await writeFile(base, { path: `${KB_DIR}/not-there.md`, content: 'x', mode: 'overwrite' });
    expect(await created.json()).toMatchObject({ outcome: 'created' });
  });

  it('write_file mode update rewrites an existing file and refuses a missing one with `missing`', async () => {
    const base = await start();
    const updated = await writeFile(base, { path: `${KB_DIR}/a.md`, content: 'second draft', mode: 'update' });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ path: `${KB_DIR}/a.md`, outcome: 'updated' });
    expect(await onDisk(`${KB_DIR}/a.md`)).toBe('second draft');

    const missing = await writeFile(base, { path: `${KB_DIR}/nowhere.md`, content: 'x', mode: 'update' });
    expect(missing.status).toBe(404);
    const body = (await missing.json()) as { error: string; code: string; path: string };
    expect(body.code).toBe('missing');
    expect(body.path).toBe(`${KB_DIR}/nowhere.md`);
    expect(body.error).toContain(`${KB_DIR}/nowhere.md`);
    await expect(onDisk(`${KB_DIR}/nowhere.md`)).rejects.toThrow();
  });

  it('write_files answers for every requested path in input order, writes the rest, and counts only what landed', async () => {
    const base = await start();
    const res = await writeFiles(base, {
      files: [
        { path: `${KB_DIR}/one.md`, content: 'first' },
        { path: `${KB_DIR}/a.md`, content: 'clobbered' }, // already there
        { path: `${KB_DIR}/two.md`, content: 'second' },
      ],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as BatchAnswer;
    expect(body.count).toBe(2);
    expect(body.files.map((f) => f.path)).toEqual([`${KB_DIR}/one.md`, `${KB_DIR}/a.md`, `${KB_DIR}/two.md`]);
    expect(body.files.map((f) => f.outcome)).toEqual(['created', 'refused', 'created']);
    expect(body.files[1].error).toBe('exists');
    expect(body.files[1].message).toContain('pass mode: overwrite to replace it');
    // The two it could write landed; the one it refused is untouched.
    expect(await onDisk(`${KB_DIR}/one.md`)).toBe('first');
    expect(await onDisk(`${KB_DIR}/two.md`)).toBe('second');
    expect(await onDisk(`${KB_DIR}/a.md`)).toBe('hello\nworld\n');
  });

  it('write_files takes the same three modes', async () => {
    const base = await start();
    const overwritten = (await (await writeFiles(base, {
      mode: 'overwrite',
      files: [{ path: `${KB_DIR}/a.md`, content: 'replaced text' }, { path: `${KB_DIR}/brand-new.md`, content: 'new' }],
    })).json()) as BatchAnswer;
    expect(overwritten.count).toBe(2);
    expect(overwritten.files.map((f) => f.outcome)).toEqual(['replaced', 'created']);
    expect(await onDisk(`${KB_DIR}/a.md`)).toBe('replaced text');

    const updated = (await (await writeFiles(base, {
      mode: 'update',
      files: [{ path: `${KB_DIR}/a.md`, content: 'again' }, { path: `${KB_DIR}/never-written.md`, content: 'x' }],
    })).json()) as BatchAnswer;
    expect(updated.count).toBe(1);
    expect(updated.files.map((f) => f.outcome)).toEqual(['updated', 'refused']);
    expect(updated.files[1].error).toBe('missing');
    await expect(onDisk(`${KB_DIR}/never-written.md`)).rejects.toThrow();
  });

  it('write_files refuses a second create for a path an earlier entry in the SAME batch already claims', async () => {
    const base = await start();
    const body = (await (await writeFiles(base, {
      files: [{ path: `${KB_DIR}/dup.md`, content: 'first' }, { path: `${KB_DIR}/dup.md`, content: 'second' }],
    })).json()) as BatchAnswer;
    expect(body.count).toBe(1);
    expect(body.files.map((f) => f.outcome)).toEqual(['created', 'refused']);
    expect(body.files[1].error).toBe('exists');
    expect(await onDisk(`${KB_DIR}/dup.md`)).toBe('first');
  });

  it('an empty batch is still an answer with both fields', async () => {
    const base = await start();
    expect(await (await writeFiles(base, { files: [] })).json()).toEqual({ count: 0, files: [] });
  });

  it('a mode that is not one of the three is refused, not read as the nearest one', async () => {
    const base = await start();
    for (const res of [
      await writeFile(base, { path: `${KB_DIR}/a.md`, content: 'x', mode: 'replace' }),
      await writeFiles(base, { files: [{ path: `${KB_DIR}/a.md`, content: 'x' }], mode: 'replace' }),
      // An empty batch is no way round it: the mode is judged before the batch is.
      await writeFiles(base, { files: [], mode: 'bogus' }),
    ]) {
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; code: string };
      expect(body.code).toBe('bad_mode');
      expect(body.error).toContain('`create`, `overwrite`, `update`');
    }
    expect(await onDisk(`${KB_DIR}/a.md`)).toBe('hello\nworld\n');
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
      raceHook = async () => { await fs.writeFile(`${KB_DIR}/contested.md`, 'theirs\n'); };
      const res = await writeFile(base, { path: `${KB_DIR}/contested.md`, content: 'mine' });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { code: string; path: string; error: string };
      expect(body.code).toBe('exists');
      expect(body.path).toBe(`${KB_DIR}/contested.md`);
      expect(body.error).toContain('pass mode: overwrite to replace it');
      // The point of the whole feature: their bytes are still there.
      expect(await onDisk(`${KB_DIR}/contested.md`)).toBe('theirs\n');
    });

    it('write_file update refuses a path another writer deleted after the preflight, and does not recreate it', async () => {
      const base = await start();
      raceHook = async () => { await fs.deleteFile(`${KB_DIR}/a.md`); };
      const res = await writeFile(base, { path: `${KB_DIR}/a.md`, content: 'second draft', mode: 'update' });
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ code: 'missing', path: `${KB_DIR}/a.md` });
      await expect(onDisk(`${KB_DIR}/a.md`)).rejects.toThrow();
    });

    it('write_file overwrite reports `replaced`, not `created`, when the file appeared after the preflight', async () => {
      const base = await start();
      raceHook = async () => { await fs.writeFile(`${KB_DIR}/late.md`, 'theirs\n'); };
      const res = await writeFile(base, { path: `${KB_DIR}/late.md`, content: 'mine', mode: 'overwrite' });
      expect(res.status).toBe(200);
      // The preflight saw nothing there and would have answered `created`.
      expect(await res.json()).toMatchObject({ path: `${KB_DIR}/late.md`, outcome: 'replaced' });
      expect(await onDisk(`${KB_DIR}/late.md`)).toBe('mine');
    });

    it('write_files drops only the path another writer took, lands the rest, and counts what landed', async () => {
      const base = await start();
      raceHook = async () => { await fs.writeFile(`${KB_DIR}/two.md`, 'theirs\n'); };
      const body = (await (await writeFiles(base, {
        files: [
          { path: `${KB_DIR}/one.md`, content: 'first' },
          { path: `${KB_DIR}/two.md`, content: 'second' },
          { path: `${KB_DIR}/three.md`, content: 'third' },
        ],
      })).json()) as BatchAnswer;
      expect(body.count).toBe(2);
      expect(body.files.map((f) => f.path)).toEqual([`${KB_DIR}/one.md`, `${KB_DIR}/two.md`, `${KB_DIR}/three.md`]);
      expect(body.files.map((f) => f.outcome)).toEqual(['created', 'refused', 'created']);
      expect(body.files[1].error).toBe('exists');
      expect(await onDisk(`${KB_DIR}/one.md`)).toBe('first');
      expect(await onDisk(`${KB_DIR}/three.md`)).toBe('third');
      expect(await onDisk(`${KB_DIR}/two.md`)).toBe('theirs\n');
    });
  });

  it('states the three modes on the `mode` input of each write tool, and once in the shared rules', async () => {
    await start();
    const tools = await toolRegistry.listInternal();
    // The paragraph that said this in BOTH descriptions is one shared rule now.
    // What stays on the tool is the input the agent fills, which is where the
    // decision is actually taken.
    const rule = sharedFileRules(testKbContext().layout).find((r) => r.id === 'write-mode')!;
    expect(rule.body).toContain('DEFAULTS TO `create`');
    expect(rule.body).toContain('On write_file and write_files');
    expect(sharedFileRulesSection(testKbContext().layout).split(rule.body)).toHaveLength(2);
    for (const name of ['write_file', 'write_files']) {
      const def = tools.find((t) => t.name === name)!;
      expect(def.description, name).not.toContain('DEFAULTS TO `create`');
      const body = (def.inputs as { properties: { body: { properties: Record<string, { enum?: string[]; description?: string }> } } }).properties.body;
      expect(body.properties.mode, name).toBeDefined();
      expect(body.properties.mode.enum, name).toEqual(['create', 'overwrite', 'update']);
      expect(body.properties.mode.description, name).toContain('default `create`');
      for (const mode of ['`create`', '`overwrite`', '`update`']) {
        expect(body.properties.mode.description, `${name} ${mode}`).toContain(mode);
      }
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

/**
 * The agent guide at the repository root. It is not a file: `read_file` of
 * its name answers with the platform's guide, after the knowledge base's own
 * file of that name when it has one, and `file_stat` says what is there.
 */
describe("the agent guide at the guide's name", () => {
  const GUIDE = `${KB_DIR}/AGENTS.md`;
  const read = (base: string, p = GUIDE, extra: Record<string, unknown> = {}) =>
    post(`${base}/api/agent/tools/read_file`, { path: p, ...extra }).then((r) => r.json() as Promise<{ path: string; content: string }>);
  const statOf = (base: string, p = GUIDE) =>
    post(`${base}/api/agent/tools/file_stat`, { path: p }).then((r) => r.json() as Promise<Record<string, unknown>>);

  it('answers with the guide when the knowledge base has no file of that name', async () => {
    guideText = 'THE PLATFORM GUIDE\n';
    const base = await start();
    expect(await read(base)).toEqual({ path: GUIDE, content: 'THE PLATFORM GUIDE\n' });
    // By the root-anchored and the prefix-less spellings too, like any path.
    expect((await read(base, `/${GUIDE}`)).content).toBe('THE PLATFORM GUIDE\n');
    expect((await read(base, 'AGENTS.md')).content).toBe('THE PLATFORM GUIDE\n');
    // Sliced like any content.
    expect((await read(base, GUIDE, { offset: 4, limit: 8 })).content).toBe('PLATFORM');
  });

  it('answers with the platform\'s composed guide, HTML views section and all', async () => {
    guideText = await composeAgentGuide(DEFAULT_KB_LAYOUT);
    const base = await start();
    const { content } = await read(base, 'AGENTS.md');
    expect(content).toBe(guideText);
    expect(content).toContain('## HTML views');
    expect(content).toContain('**A bare fragment scrolls the page.**');
  });

  it("puts the knowledge base's own AGENTS.md first, then the separator, then the guide", async () => {
    guideText = 'THE PLATFORM GUIDE\n';
    const base = await start();
    await fs.writeFile(`${KB_DIR}/AGENTS.md`, '# Acme\n\nWrite tickets in the present tense.\n');
    const { content } = await read(base);
    expect(content.startsWith('# Acme\n\nWrite tickets in the present tense.\n\n---\n')).toBe(true);
    expect(content.endsWith('\n\nTHE PLATFORM GUIDE\n')).toBe(true);
    expect(content).toContain("The text above is this knowledge base's own conventions file.");
  });

  it('never serves a copy of the guide an earlier release left on disk a second time', async () => {
    guideText = 'THE PLATFORM GUIDE\n';
    const base = await start();
    await fs.writeFile(`${KB_DIR}/AGENTS.md`, '# Knowledge base\n\n> **This file is managed by the platform.** Stale.\n');
    expect((await read(base)).content).toBe('THE PLATFORM GUIDE\n');
  });

  it("never tells a caller who may not read the knowledge base's own file that it exists", async () => {
    guideText = 'THE PLATFORM GUIDE\n';
    const denied = await start('read', denyReads(new Set(['AGENTS.md'])));
    // Nothing of theirs there: the guide is everyone's.
    const absent = await read(denied);
    const absentStat = await statOf(denied);
    expect(absent.content).toBe('THE PLATFORM GUIDE\n');
    // A file they may not read answers EXACTLY as no file does — a refusal
    // would be the one thing the platform never says about a restricted
    // file, which is that it is there.
    await fs.writeFile(`${KB_DIR}/AGENTS.md`, '# Acme\n\nThe secret conventions.\n');
    const closed = await post(`${denied}/api/agent/tools/read_file`, { path: GUIDE });
    expect(closed.status).toBe(200);
    expect(await closed.json()).toEqual(absent);
    expect(await statOf(denied)).toEqual(absentStat);
  });

  it("serves the knowledge base's own file to a caller who may read it", async () => {
    guideText = 'THE PLATFORM GUIDE\n';
    const allowed = await start('read');
    await fs.writeFile(`${KB_DIR}/AGENTS.md`, '# Acme\n\nThe conventions.\n');
    expect((await read(allowed)).content).toContain('The conventions.');
  });

  it("answers the guide alone when the knowledge base's own file vanishes between the probe and the read", async () => {
    guideText = 'THE PLATFORM GUIDE\n';
    const base = await start();
    // The file is there when it is probed and gone when it is read: a
    // concurrent delete, which is the absent case and never a failure.
    const probed = fs.stat.bind(fs);
    let vanish = false;
    (fs as unknown as Record<string, unknown>).stat = async (p: string) => {
      const st = await probed(p);
      if (vanish && p.endsWith('AGENTS.md')) {
        vanish = false;
        await fs.deleteFile(p);
      }
      return st;
    };
    await fs.writeFile(`${KB_DIR}/AGENTS.md`, '# Acme\n');
    vanish = true;
    expect(await read(base)).toEqual({ path: GUIDE, content: 'THE PLATFORM GUIDE\n' });
    await fs.writeFile(`${KB_DIR}/AGENTS.md`, '# Acme\n');
    vanish = true;
    expect(await statOf(base)).toMatchObject({ platformGuide: true });
  });

  it('leaves a folder at the guide\'s name to the ordinary stat, and never reads it as a copy', async () => {
    guideText = 'THE PLATFORM GUIDE\n';
    const base = await start();
    await fs.mkdir(`${KB_DIR}/AGENTS.md`);
    const folder = await statOf(base);
    expect(folder).toMatchObject({ type: 'directory' });
    expect(folder.platformGuide).toBeUndefined();
  });

  it('is a nested AGENTS.md no concern of: that is a file like any other', async () => {
    guideText = 'THE PLATFORM GUIDE\n';
    const base = await start();
    await fs.writeFile(`${KB_DIR}/Handbook/AGENTS.md`, '# Handbook\n');
    expect((await read(base, `${KB_DIR}/Handbook/AGENTS.md`)).content).toBe('# Handbook\n');
    expect((await post(`${base}/api/agent/tools/read_file`, { path: `${KB_DIR}/Handbook/HEXIS.md` })).status).toBe(404);
  });

  it('grep finds the guide where read_file serves it: from the root and at its own path, own file first, denied file absent', async () => {
    guideText = '# Guide\n\nName every needle you plant.\n';
    const grep = (base: string, pattern: string, path?: string) =>
      post(`${base}/api/agent/tools/grep`, path === undefined ? { pattern } : { pattern, path }).then(
        (r) => r.json() as Promise<{ matches: { path: string; line: number; text: string }[] }>,
      );
    const base = await start();
    await fs.writeFile(`${KB_DIR}/Handbook/a.md`, 'a needle on disk\n');
    // A search of the whole knowledge base reaches the guide, under the path
    // a read of it answers to, with the line number that read gives.
    const fromRoot = await grep(base, 'needle');
    expect(fromRoot.matches).toContainEqual({ path: GUIDE, line: 3, text: 'Name every needle you plant.' });
    expect(fromRoot.matches).toContainEqual({ path: `${KB_DIR}/Handbook/a.md`, line: 1, text: 'a needle on disk' });
    // A search of the guide's own path is a search of what read_file answers.
    expect((await grep(base, 'needle', GUIDE)).matches).toEqual([{ path: GUIDE, line: 3, text: 'Name every needle you plant.' }]);
    expect((await grep(base, 'needle', 'AGENTS.md')).matches).toEqual([{ path: GUIDE, line: 3, text: 'Name every needle you plant.' }]);
    // A search under a folder does not reach a file that is not under it.
    expect((await grep(base, 'needle', `${KB_DIR}/Handbook`)).matches.map((m) => m.path)).toEqual([`${KB_DIR}/Handbook/a.md`]);

    // With the knowledge base's own AGENTS.md, the search covers the composed
    // text — the own file first, then the guide — and once: the walk's own
    // matches in that file are the same lines, so they are not repeated.
    await fs.writeFile(`${KB_DIR}/AGENTS.md`, '# Acme\n\nOur needle rule.\n');
    const { content } = await read(base);
    const guideLine = content.split('\n').indexOf('Name every needle you plant.') + 1;
    const composed = (await grep(base, 'needle')).matches.filter((m) => m.path === GUIDE);
    expect(composed).toEqual([
      { path: GUIDE, line: 3, text: 'Our needle rule.' },
      { path: GUIDE, line: guideLine, text: 'Name every needle you plant.' },
    ]);
    expect((await grep(base, 'needle', GUIDE)).matches).toEqual(composed);

    // The own file does not use up `max_results` twice: the walk leaves it to
    // the composed search, so a file later in the tree is still reached when
    // the own file alone has more matches than the cap. Without that, the
    // walk filled the cap from AGENTS.md, those matches were dropped as
    // duplicates, and Handbook/ was never searched.
    await fs.writeFile(`${KB_DIR}/AGENTS.md`, `# Acme\n\n${'needle\n'.repeat(5)}`);
    const capped = (await (await post(`${base}/api/agent/tools/grep`, { pattern: 'needle', max_results: 3 })).json()) as {
      matches: { path: string }[];
    };
    expect(capped.matches.map((m) => m.path)).toContain(`${KB_DIR}/Handbook/a.md`);
    expect(capped.matches).toHaveLength(3);
    await fs.writeFile(`${KB_DIR}/AGENTS.md`, '# Acme\n\nOur needle rule.\n');

    // A caller who may not read the own file searches the guide alone, from
    // the root and at the path — as read_file answers them, with no sign that
    // anything of the organisation's is there.
    const denied = await start('read', denyReads(new Set(['AGENTS.md'])));
    await fs.writeFile(`${KB_DIR}/AGENTS.md`, '# Acme\n\nOur needle rule.\n');
    for (const found of [await grep(denied, 'needle'), await grep(denied, 'needle', GUIDE)]) {
      expect(found.matches.filter((m) => m.path === GUIDE)).toEqual([{ path: GUIDE, line: 3, text: 'Name every needle you plant.' }]);
      expect(JSON.stringify(found)).not.toContain('Acme');
    }
  });

  it('file_stat says a text file is there to read, and that nothing can be written, moved or deleted at it', async () => {
    guideText = 'THE PLATFORM GUIDE\n';
    const base = await start();
    expect(await statOf(base)).toMatchObject({
      name: 'AGENTS.md',
      type: 'file',
      size: Buffer.byteLength('THE PLATFORM GUIDE\n'),
      platformGuide: true,
      managed: true,
      movable: false,
      deletable: false,
      contentMode: 'text',
      textEditable: false,
      access: { read: true, write: false },
    });
    // With a file of the knowledge base's own there, stat describes THAT file.
    await fs.writeFile(`${KB_DIR}/AGENTS.md`, '# Acme\n');
    const own = await statOf(base);
    expect(own).toMatchObject({ name: 'AGENTS.md', type: 'file', managed: false, movable: true, textEditable: true });
    expect(own.platformGuide).toBeUndefined();
    // A copy an earlier release wrote is what read_file does not serve, so
    // stat says the same thing it says for no file at all.
    await fs.writeFile(`${KB_DIR}/AGENTS.md`, '# Knowledge base\n\n> **This file is managed by the platform.** Stale.\n');
    expect(await statOf(base)).toMatchObject({ platformGuide: true, managed: true, movable: false });
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

  it('gates on the repository path, not on the spelling the caller sent', async () => {
    // `a.md` is seeded through the normaliser like every path in this file, so
    // it sits INSIDE the checkout, at `<tempDir>/knowledge-base/a.md`. Nothing
    // is outside the KB dir any more. The gate keys on the repo-relative path,
    // so a rule written on the workspace-relative spelling names no file…
    const base = await start('read', denyReads(new Set([`${KB_DIR}/a.md`])));
    expect((await post(`${base}/api/agent/tools/read_file`, { path: `${KB_DIR}/a.md` })).status).toBe(200);
    // …and the same read, with the rule on the key the gate actually uses, is
    // denied: what is checked is the path the read resolves, whichever of its
    // spellings the caller sent.
    const gated = await start('read', denyReads(new Set(['a.md'])));
    for (const path of ['a.md', `${KB_DIR}/a.md`, `/${KB_DIR}/a.md`]) {
      expect((await post(`${gated}/api/agent/tools/read_file`, { path })).status, path).toBe(403);
    }
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
    await fs.writeFile(`${KB_DIR}/notes/deep.md`, 'alpha\nbeta needle\ngamma\n');
    // A sibling holding the same term: a file grep must not reach it.
    await fs.writeFile(`${KB_DIR}/notes/other.md`, 'needle elsewhere\n');
    const res = await grep(base, { pattern: 'needle', path: `${KB_DIR}/notes/deep.md` });
    expect(res.matches).toEqual([{ path: `${KB_DIR}/notes/deep.md`, line: 2, text: 'beta needle' }]);
    expect(res.truncated).toBe(false);
    expect(res.note).toBeUndefined();
  });

  it('a file the pattern is simply not in is an empty SUCCESS — no note, no error', async () => {
    const base = await start();
    const res = await grep(base, { pattern: 'absent-term', path: `${KB_DIR}/a.md` });
    expect(res.matches).toEqual([]);
    expect(res.truncated).toBe(false);
    expect(res.note).toBeUndefined();
  });

  it('caps a file grep at max_results and reports truncated, exactly as a directory grep does', async () => {
    const base = await start();
    await fs.writeFile(`${KB_DIR}/many.md`, 'needle\n'.repeat(5));
    const res = await grep(base, { pattern: 'needle', path: `${KB_DIR}/many.md`, max_results: 2 });
    expect(res.matches.map((m) => m.line)).toEqual([1, 2]);
    expect(res.truncated).toBe(true);
  });

  it('a file with no searchable text returns empty matches plus a note saying so', async () => {
    const base = await start();
    // "needle" followed by a NUL byte: binary content, so nothing to search —
    // the byte pattern is present but the file is not text.
    await fs.writeFile(`${KB_DIR}/data.bin`, Buffer.from('needle\0tail', 'latin1'));
    await fs.writeFile(
      `${KB_DIR}/logo.png`,
      Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'),
    );
    for (const path of [`${KB_DIR}/data.bin`, `${KB_DIR}/logo.png`]) {
      const res = await grep(base, { pattern: 'needle', path });
      expect(res.matches, path).toEqual([]);
      expect(res.note, path).toContain('no searchable text');
      expect(res.note, path).toContain(path);
    }
  });

  it('a path with nothing at it fails with an error naming the path — never an empty success', async () => {
    const base = await start();
    const res = await post(`${base}/api/agent/tools/grep`, { pattern: 'needle', path: `${KB_DIR}/notes/ghost.md` });
    expect(res.status).toBe(404);
    const { error } = (await res.json()) as { error: string };
    expect(error).toContain(`${KB_DIR}/notes/ghost.md`);
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
    await fs.writeFile(`${KB_DIR}/notes/deep.md`, 'alpha\n');
    // `notes/deep.md` is a FILE, so the filesystem answers ENOTDIR rather than
    // ENOENT. Nothing can live at this path either, so it earns the same
    // honest 404 as a plainly absent one.
    const res = await post(`${base}/api/agent/tools/grep`, {
      pattern: 'needle',
      path: `${KB_DIR}/notes/deep.md/deeper.md`,
    });
    expect(res.status).toBe(404);
    const { error } = (await res.json()) as { error: string };
    expect(error).toContain(`${KB_DIR}/notes/deep.md/deeper.md`);
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
    await fs.writeFile(`${KB_DIR}/notes/one.md`, 'needle here\n');
    await fs.writeFile(`${KB_DIR}/notes/sub/two.md`, 'and needle there\n');
    await fs.writeFile(`${KB_DIR}/outside.md`, 'needle outside the subtree\n');
    const res = await grep(base, { pattern: 'needle', path: 'notes' });
    expect(res.matches.map((m) => m.path).sort()).toEqual([`${KB_DIR}/notes/one.md`, `${KB_DIR}/notes/sub/two.md`]);
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
    await fs.writeFile(`${KB_DIR}/report.docx`, docx('Hello from Word', 'Second paragraph'));
    const content = await readContent(base, `${KB_DIR}/report.docx`);
    const lines = content.split('\n');
    expect(lines[0]).toMatch(new RegExp(`^\\[extracted text of ${KB_DIR}/report\\.docx — 2 paragraphs;`));
    expect(lines[0]).toContain('layout, images and formatting omitted');
    expect(lines.slice(1)).toEqual(['Hello from Word', 'Second paragraph']);
  });

  it('read_file slices offset/limit AFTER assembling marker + text (unchanged semantics)', async () => {
    const base = await start();
    await fs.writeFile(`${KB_DIR}/report.docx`, docx('Sliceable content here'));
    const full = await readContent(base, `${KB_DIR}/report.docx`);
    const sliced = await readContent(base, `${KB_DIR}/report.docx`, { offset: 5, limit: 12 });
    expect(sliced).toBe(full.slice(5, 17));
  });

  it('read_file returns [page N] text for a PDF', async () => {
    const base = await start();
    await fs.writeFile(`${KB_DIR}/paper.pdf`, pdf('Findings inside a PDF'));
    const content = await readContent(base, `${KB_DIR}/paper.pdf`);
    expect(content).toMatch(new RegExp(`^\\[extracted text of ${KB_DIR}/paper\\.pdf — 1 page;`));
    expect(content).toContain('[page 1]\nFindings inside a PDF');
  });

  it('grep finds a term inside a pptx, with the [slide N] marker line locating it', async () => {
    const base = await start();
    await fs.writeFile(`${KB_DIR}/deck.pptx`, pptx([['Intro'], ['Roadmap 2026', 'Ship documents']]));
    const res = (await (await post(`${base}/api/agent/tools/grep`, { pattern: 'Roadmap' })).json()) as {
      matches: { path: string; line: number; text: string }[];
      note?: string;
    };
    expect(res.matches).toContainEqual(expect.objectContaining({ path: `${KB_DIR}/deck.pptx`, text: 'Roadmap 2026' }));
    // The extraction reads: marker line 1, [slide 1] line 2, Intro line 3,
    // [slide 2] line 4, Roadmap line 5 — grep reports the extraction's numbers.
    expect(res.matches.find((m) => m.text === 'Roadmap 2026')?.line).toBe(5);
    // The structure markers themselves are searchable.
    const markers = (await (await post(`${base}/api/agent/tools/grep`, { pattern: '\\[slide 2\\]' })).json()) as { matches: { path: string }[] };
    expect(markers.matches).toContainEqual(expect.objectContaining({ path: `${KB_DIR}/deck.pptx` }));
    expect(res.note).toBeUndefined();
  });

  it('grep on a path naming a DOCUMENT searches its extraction the way the walk does — markers included', async () => {
    const base = await start();
    await fs.writeFile(`${KB_DIR}/deck.pptx`, pptx([['Intro'], ['Roadmap 2026']]));
    // A second deck carrying the same term: a file grep must not reach it.
    await fs.writeFile(`${KB_DIR}/decoy.pptx`, pptx([['Roadmap 2026 decoy deck']]));
    const res = (await (await post(`${base}/api/agent/tools/grep`, { pattern: 'Roadmap', path: `${KB_DIR}/deck.pptx` })).json()) as {
      matches: { path: string; line: number; text: string }[];
      note?: string;
    };
    // Same line arithmetic as the directory grep: marker 1, [slide 1] 2,
    // Intro 3, [slide 2] 4, Roadmap 5.
    expect(res.matches).toEqual([{ path: `${KB_DIR}/deck.pptx`, line: 5, text: 'Roadmap 2026' }]);
    expect(res.note).toBeUndefined();
    // The structure markers are searchable on the single-file path too.
    const markers = (await (await post(`${base}/api/agent/tools/grep`, { pattern: '\\[slide 2\\]', path: `${KB_DIR}/deck.pptx` })).json()) as {
      matches: { path: string; line: number }[];
    };
    expect(markers.matches).toEqual([expect.objectContaining({ path: `${KB_DIR}/deck.pptx`, line: 4 })]);
  });

  it('grep on a path naming a CORRUPT document notes it has no searchable text', async () => {
    const base = await start();
    await fs.writeFile(`${KB_DIR}/broken.docx`, Buffer.from('not really a zip'));
    const res = (await (await post(`${base}/api/agent/tools/grep`, { pattern: 'zip', path: `${KB_DIR}/broken.docx` })).json()) as {
      matches: unknown[];
      note?: string;
    };
    expect(res.matches).toEqual([]);
    expect(res.note).toContain('no searchable text');
    expect(res.note).toContain(`${KB_DIR}/broken.docx`);
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
    await fs.writeFile(`${KB_DIR}/memo.odt`, odt('Hello from Writer', 'Second paragraph'));
    const odtContent = await readContent(base, `${KB_DIR}/memo.odt`);
    expect(odtContent.split('\n')).toEqual([
      `[extracted text of ${KB_DIR}/memo.odt — 2 paragraphs; layout, images and formatting omitted]`,
      'Hello from Writer',
      'Second paragraph',
    ]);

    await fs.writeFile(`${KB_DIR}/deck.odp`, odp([['Impress intro'], ['Second page']]));
    const odpContent = await readContent(base, `${KB_DIR}/deck.odp`);
    expect(odpContent).toMatch(new RegExp(`^\\[extracted text of ${KB_DIR}/deck\\.odp — 2 slides;`));
    expect(odpContent).toContain('[slide 1]\nImpress intro\n[slide 2]\nSecond page');

    await fs.writeFile(`${KB_DIR}/numbers.ods`, ods('Inventory', [['Name', 'Qty'], ['Widget', '3']]));
    const odsContent = await readContent(base, `${KB_DIR}/numbers.ods`);
    expect(odsContent).toMatch(new RegExp(`^\\[extracted text of ${KB_DIR}/numbers\\.ods — 1 sheet, rows as tab-separated values;`));
    expect(odsContent).toContain('[sheet: Inventory]\nName\tQty\nWidget\t3');
  });

  it('grep finds a term inside an odp, with the [slide N] marker line locating it', async () => {
    const base = await start();
    await fs.writeFile(`${KB_DIR}/deck.odp`, odp([['Intro'], ['Roadmap 2027', 'Ship OpenDocument']]));
    const res = (await (await post(`${base}/api/agent/tools/grep`, { pattern: 'Roadmap' })).json()) as {
      matches: { path: string; line: number; text: string }[];
    };
    // Extraction: marker line 1, [slide 1] 2, Intro 3, [slide 2] 4, Roadmap 5.
    expect(res.matches).toContainEqual(expect.objectContaining({ path: `${KB_DIR}/deck.odp`, text: 'Roadmap 2027', line: 5 }));
    const markers = (await (await post(`${base}/api/agent/tools/grep`, { pattern: '\\[slide 2\\]' })).json()) as { matches: { path: string }[] };
    expect(markers.matches).toContainEqual(expect.objectContaining({ path: `${KB_DIR}/deck.odp` }));
  });

  it('read_file answers a corrupt odt zip with an honest could-not-parse message (no 500)', async () => {
    const base = await start();
    await fs.writeFile(`${KB_DIR}/broken.odt`, Buffer.from('not really a zip'));
    const res = await post(`${base}/api/agent/tools/read_file`, { path: `${KB_DIR}/broken.odt` });
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
    await fs.writeFile(`${KB_DIR}/Inbox/offer.eml`, eml('Quarterly numbers', 'Please see the summary.'));
    const content = await readContent(base, `${KB_DIR}/Inbox/offer.eml`);
    expect(content.split('\n')).toEqual([
      `[extracted text of ${KB_DIR}/Inbox/offer.eml — email message; formatting and full headers omitted]`,
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
    await fs.writeFile(`${KB_DIR}/Inbox/offer.eml`, eml('Quarterly numbers', 'The needle-2026 is in the body.'));
    const res = (await (await post(`${base}/api/agent/tools/grep`, { pattern: 'needle-2026' })).json()) as {
      matches: { path: string; line: number; text: string }[];
    };
    // Extraction: marker 1, [from] 2, [to] 3, [subject] 4, [date] 5, blank 6, body 7.
    expect(res.matches).toContainEqual(
      expect.objectContaining({ path: `${KB_DIR}/Inbox/offer.eml`, text: 'The needle-2026 is in the body.', line: 7 }),
    );
    const header = (await (await post(`${base}/api/agent/tools/grep`, { pattern: '\\[subject\\] Quarterly' })).json()) as {
      matches: { path: string; line: number }[];
    };
    expect(header.matches).toContainEqual(expect.objectContaining({ path: `${KB_DIR}/Inbox/offer.eml`, line: 4 }));
  });

  it('write_file / edit_file refuse email files with the snapshot explanation', async () => {
    const base = await start();
    await fs.writeFile(`${KB_DIR}/Inbox/offer.eml`, eml('original', 'original body'));
    for (const [tool, body] of [
      ['write_file', { path: `${KB_DIR}/Inbox/offer.eml`, content: 'rewritten' }],
      ['write_file', { path: `${KB_DIR}/Inbox/new-thread.msg`, content: 'plain text' }],
      ['edit_file', { path: `${KB_DIR}/Inbox/offer.eml`, old_string: 'original', new_string: 'changed' }],
    ] as const) {
      const res = await post(`${base}/api/agent/tools/${tool}`, body);
      expect(res.status, tool).toBe(415);
      const { error } = (await res.json()) as { error: string };
      expect(error, tool).toContain('email file');
      expect(error, tool).toContain('snapshot');
      expect(error, tool).toContain('uploading a new version');
    }
    // The email is untouched: reading it still extracts the original text.
    expect(await readContent(base, `${KB_DIR}/Inbox/offer.eml`)).toContain('original body');
  });

  it('read_file answers a corrupt .msg with an honest could-not-parse message (no 500)', async () => {
    const base = await start();
    await fs.writeFile(`${KB_DIR}/Inbox/broken.msg`, Buffer.from('not a CFB container'));
    const res = await post(`${base}/api/agent/tools/read_file`, { path: `${KB_DIR}/Inbox/broken.msg` });
    expect(res.status).toBe(200);
    const { content } = (await res.json()) as { content: string };
    expect(content).toContain('could not be parsed as a .msg');
    expect(content).toContain('uploading a new version');
  });

  it('read_file answers a corrupt docx with an honest could-not-parse message (no 500)', async () => {
    const base = await start();
    await fs.writeFile(`${KB_DIR}/broken.docx`, Buffer.from('not really a zip'));
    const res = await post(`${base}/api/agent/tools/read_file`, { path: `${KB_DIR}/broken.docx` });
    expect(res.status).toBe(200);
    const { content } = (await res.json()) as { content: string };
    expect(content).toContain('could not be parsed as a .docx');
    expect(content).toContain('uploading a new version');
  });

  it('read_file answers a legacy .doc with the convert-to-modern hint', async () => {
    const base = await start();
    await fs.writeFile(`${KB_DIR}/old.doc`, Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0x00, 0x01, 0x02]));
    const content = await readContent(base, `${KB_DIR}/old.doc`);
    expect(content).toContain('legacy office format');
    expect(content).toContain('.docx');
  });

  it('edit_file / write_file refuse a legacy .doc with the convert-or-replace message — a binary the reader cannot extract must never be text-overwritten', async () => {
    const base = await start();
    await fs.writeFile(`${KB_DIR}/old.doc`, Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0x00, 0x01, 0x02]));
    for (const [tool, body] of [
      ['edit_file', { path: `${KB_DIR}/old.doc`, old_string: 'a', new_string: 'b' }],
      ['write_file', { path: `${KB_DIR}/old.doc`, content: 'plain text' }],
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
    await fs.writeFile(`${KB_DIR}/blob.dat`, Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff]));
    for (const [tool, body] of [
      ['write_file', { path: `${KB_DIR}/blob.dat`, content: 'plain text' }],
      ['edit_file', { path: `${KB_DIR}/blob.dat`, old_string: 'a', new_string: 'b' }],
    ] as const) {
      const res = await post(`${base}/api/agent/tools/${tool}`, body);
      expect(res.status, tool).toBe(415);
      const { error } = (await res.json()) as { error: string };
      expect(error, tool).toContain('binary content');
      expect(error, tool).toContain('uploading a new version');
    }
    // …and a TEXT file under the same fallback reader still writes normally.
    const ok = await post(`${base}/api/agent/tools/write_file`, { path: `${KB_DIR}/notes.dat`, content: 'hello' });
    expect(ok.status).toBe(200);
  });

  it('read_file answers other binary files with a one-line notice (zip names the unzip tool)', async () => {
    const base = await start();
    // .mp3, not an image: images return native MCP image content (see below).
    await fs.writeFile(`${KB_DIR}/song.mp3`, Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00]));
    const mp3 = await readContent(base, `${KB_DIR}/song.mp3`);
    expect(mp3).toBe(`[${KB_DIR}/song.mp3 is a binary file (audio/mpeg, 9 bytes) — not readable as text.]`);
    await fs.writeFile(`${KB_DIR}/bundle.zip`, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]));
    const zip = await readContent(base, `${KB_DIR}/bundle.zip`);
    expect(zip).toContain('application/zip');
    expect(zip).toContain('unzip tool');
  });

  it('write_file / edit_file / write_files refuse document extensions with the round-trip explanation', async () => {
    const base = await start();
    await fs.writeFile(`${KB_DIR}/deck.pptx`, pptx([['Original']]));
    for (const [tool, body] of [
      ['write_file', { path: `${KB_DIR}/new.docx`, content: 'plain text' }],
      ['write_file', { path: `${KB_DIR}/new.odt`, content: 'plain text' }],
      ['write_file', { path: `${KB_DIR}/slides.odp`, content: 'plain text' }],
      ['edit_file', { path: `${KB_DIR}/deck.pptx`, old_string: 'Original', new_string: 'Changed' }],
      ['edit_file', { path: `${KB_DIR}/numbers.ods`, old_string: 'a', new_string: 'b' }],
    ] as const) {
      const res = await post(`${base}/api/agent/tools/${tool}`, body);
      expect(res.status, tool).toBe(415);
      const { error } = (await res.json()) as { error: string };
      expect(error, tool).toContain('EXTRACTED text');
      expect(error, tool).toContain('uploading a new version');
    }
    // In a BATCH the same refusal is per path: the document is refused with the
    // same explanation, and the innocent .md beside it is still written.
    for (const doc of [`${KB_DIR}/sheet.xlsx`, `${KB_DIR}/sheet.ods`]) {
      const res = await post(`${base}/api/agent/tools/write_files`, {
        files: [{ path: `${doc}.ok.md`, content: 'fine' }, { path: doc, content: 'nope' }],
      });
      expect(res.status, doc).toBe(200);
      const body = (await res.json()) as { count: number; files: { path: string; outcome: string; error?: string; message?: string }[] };
      expect(body.count, doc).toBe(1);
      expect(body.files.map((f) => f.path), doc).toEqual([`${doc}.ok.md`, doc]);
      expect(body.files[0], doc).toMatchObject({ outcome: 'created' });
      expect(body.files[1], doc).toMatchObject({ outcome: 'refused', error: 'binary_not_writable' });
      expect(body.files[1].message, doc).toContain('EXTRACTED text');
      expect(body.files[1].message, doc).toContain('uploading a new version');
      expect(await readContent(base, `${doc}.ok.md`)).toBe('fine');
      expect((await post(`${base}/api/agent/tools/file_stat`, { path: doc })).status, doc).not.toBe(200);
    }
    // And the pptx is untouched: reading it still extracts the original text.
    expect(await readContent(base, `${KB_DIR}/deck.pptx`)).toContain('Original');
  });

  it('every mounted tool opens with the one sentence sending the agent to the guide, and repeats none of the rules', async () => {
    await start();
    const tools = await toolRegistry.listInternal();
    // The shell is in the list too: it carried the agent-guide reminder before,
    // and that reminder is one of the rules that moved.
    const mounted = ['read_file', 'list_files', 'file_stat', 'grep', 'write_file', 'write_files', 'edit_file', 'delete_file', 'delete_folder', 'mkdir', 'move_file', 'copy_file', 'unzip', 'execute_command'];
    for (const name of mounted) {
      const def = tools.find((t) => t.name === name);
      expect(def, name).toBeDefined();
      expect(def!.description!.startsWith(`${GUIDE_FIRST_SENTENCE} `), name).toBe(true);
      // Once, at the front — not once per paragraph that used to be appended.
      expect(def!.description!.split(GUIDE_FIRST_SENTENCE), name).toHaveLength(2);
      // EVERY shared rule, in full, is in the two shared places now (see
      // agent-instructions/__tests__/shared-file-rules.test.ts) and in no
      // description. Checked on the whole body rather than on a phrase: the
      // drift this PR exists to prevent is a paragraph pasted back onto a
      // tool, and naming only two marker phrases would catch two of eight.
      for (const rule of sharedFileRules(testKbContext().layout)) {
        expect(def!.description, `${name} / ${rule.id}`).not.toContain(rule.body);
      }
      // The two lead-in labels the paragraphs used to arrive under are gone
      // with them — a description carrying one is carrying the old text.
      expect(def!.description, name).not.toContain('Content rule (the same on every file tool)');
      expect(def!.description, name).not.toContain('Before your first read or change in a workspace');
    }
    // start_session touches no file, yet it opens with the same sentence: the
    // guide is read before ANYTHING in the platform, a session included.
    // External-only, so it is looked up on that surface.
    const external = await toolRegistry.listExternal();
    expect(external.find((t) => t.name === 'start_session')!.description!.startsWith(`${GUIDE_FIRST_SENTENCE} `)).toBe(true);
  });

  /**
   * The call example at the top of every description is generated from the
   * tool's input schema, and the same schema is what the argument check reads.
   * If the two could disagree, the platform would publish an example its own
   * check refuses — so every declared tool is called with its own example here.
   */
  it('every declared tool can be called with its own generated example', async () => {
    await start();
    const tools = await toolRegistry.listInternal();
    // The whole family this harness declares, the four the scenarios name included.
    for (const name of ['read_file', 'write_file', 'list_files', 'grep']) {
      expect(tools.some((t) => t.name === name), name).toBe(true);
    }
    expect(tools.length).toBeGreaterThan(12);
    for (const def of tools) {
      const compiled = compileCheck(def.inputs);
      expect(compiled.checkable, `${def.name}: ${compiled.checkable ? '' : compiled.reason}`).toBe(true);
      // Narrowed by hand: the assertion above already failed the test if not.
      if (!compiled.checkable) throw new Error(compiled.reason);
      expect(compiled.check(exampleArguments(def.inputs)), def.name).toEqual([]);
      // And the FLAT schema, which is what the tool's own route checks the
      // call against: the two must agree, or a call the example produced would
      // be refused one layer in.
      const flat = routeToolSchemas(def.name)?.flat;
      expect(flat, def.name).toBeDefined();
      const flatCheck = compileCheck(flat);
      expect(flatCheck.checkable, `${def.name} (flat): ${flatCheck.checkable ? '' : flatCheck.reason}`).toBe(true);
      if (!flatCheck.checkable) throw new Error(flatCheck.reason);
      expect(flatCheck.check(exampleArguments(flat)), `${def.name} (flat)`).toEqual([]);
    }
  });

  it('every description, call example and purpose prefix included, stays inside the cap a client shows', async () => {
    await start();
    const tools = await toolRegistry.listInternal();
    for (const def of tools) {
      // Measured as a CLIENT receives it: the call line, the purpose prefix at
      // its own cap (the four knowledge-base tools carry one), and the
      // description — the three things that ride one tool's entry.
      const received = clientVisibleLength(def);
      expect(received, `${def.name} is ${received} characters (cap ${TOOL_DESCRIPTION_CAP})`).toBeLessThanOrEqual(
        TOOL_DESCRIPTION_CAP,
      );
    }
  });

  describe('binary capability contract: a text file, a document, an image and a zip', () => {
    const PNG = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64',
    );
    const zipBytes = (): Buffer => {
      const z = new AdmZip();
      z.addFile(`${KB_DIR}/inner.md`, Buffer.from('# inner\n'));
      return z.toBuffer();
    };
    /** Seed the four kinds; returns each path with its exact bytes and expected answers. */
    const seed = async () => {
      const files = [
        { path: `${KB_DIR}/notes.md`, bytes: Buffer.from('hello text\n'), mode: 'text', kind: null },
        { path: `${KB_DIR}/deck.pptx`, bytes: pptx([['Original']]), mode: 'document', kind: 'document' },
        { path: `${KB_DIR}/logo.png`, bytes: PNG, mode: 'binary', kind: 'image' },
        { path: `${KB_DIR}/bundle.zip`, bytes: zipBytes(), mode: 'binary', kind: 'archive' },
      ] as const;
      for (const f of files) await fs.writeFile(f.path, f.bytes);
      return files;
    };
    /** `path` is a repository path, which is workspace-relative already. */
    const onDisk = async (path: string) => Buffer.from(await readFile(join(tempDir, path)));
    /** A sibling of `path` under `dir`, inside the repository. */
    const under = (dir: string, path: string) => `${KB_DIR}/${dir}/${path.slice(KB_DIR.length + 1)}`;
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
      await fs.writeFile(`${KB_DIR}/blob.dat`, Buffer.from([0x00, 0xff]));
      const blob = (await (await post(`${base}/api/agent/tools/file_stat`, { path: `${KB_DIR}/blob.dat` })).json()) as Record<string, unknown>;
      expect(blob.contentMode).toBe('binary');
      // A directory has no content mode.
      await fs.mkdir(`${KB_DIR}/dir`, { recursive: true });
      const dir = (await (await post(`${base}/api/agent/tools/file_stat`, { path: `${KB_DIR}/dir` })).json()) as Record<string, unknown>;
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
      await fs.writeFile(`${KB_DIR}/notes.md`, Buffer.from('# notes\n'));
      await fs.mkdir('folder', { recursive: true });
      for (const p of ['Sample file', `${KB_DIR}/notes.md`, 'folder']) {
        expect(await stat(p), p).not.toHaveProperty('mimeType');
      }
      expect(await stat(`${KB_DIR}/notes.md`)).toMatchObject({ kind: 'text', mime: 'text/plain' });
      await fs.writeFile(`${KB_DIR}/plata.pdf`, Buffer.from('%PDF-1.4\n'));
      expect(await stat(`${KB_DIR}/plata.pdf`)).toMatchObject({ kind: 'document', mime: 'application/pdf', textEditable: false });
      await seed();
      expect(await stat(`${KB_DIR}/deck.pptx`)).toMatchObject({ kind: 'document', mimeSource: 'extension', textEditable: false });
      expect(await stat(`${KB_DIR}/logo.png`)).toMatchObject({ kind: 'image', mime: 'image/png', textEditable: false });
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
      await expectRefusal(await post(`${base}/api/agent/tools/write_file`, { path: `${KB_DIR}/new.png`, content: 'x' }), 'image', `${KB_DIR}/new.png`);
      await expectRefusal(await post(`${base}/api/agent/tools/write_file`, { path: `${KB_DIR}/new.zip`, content: 'x' }), 'archive', `${KB_DIR}/new.zip`);
      expect((await post(`${base}/api/agent/tools/file_stat`, { path: `${KB_DIR}/new.png` })).status).not.toBe(200);
    });

    it('copy_file and move_file carry every kind byte-for-byte', async () => {
      const base = await start();
      for (const f of await seed()) {
        const copied = await post(`${base}/api/agent/tools/copy_file`, { src: f.path, dest: under('copies', f.path) });
        expect(copied.status, f.path).toBe(200);
        expect((await onDisk(under('copies', f.path))).equals(f.bytes), `copy ${f.path}`).toBe(true);
        const moved = await post(`${base}/api/agent/tools/move_file`, { src: f.path, dest: under('moved', f.path) });
        expect(moved.status, f.path).toBe(200);
        expect((await onDisk(under('moved', f.path))).equals(f.bytes), `move ${f.path}`).toBe(true);
      }
      // The moved zip is still a real archive: unzip reads it as bytes.
      const z = new AdmZip(await onDisk(`${KB_DIR}/moved/bundle.zip`));
      expect(z.getEntry(`${KB_DIR}/inner.md`)?.getData().toString('utf8')).toBe('# inner\n');
    });
  });

  it('says where the images a page uses go — once, in the shared rules', async () => {
    await start();
    const tools = await toolRegistry.listInternal();
    const rule = sharedFileRules(testKbContext().layout).find((r) => r.id === 'images-in-pages')!;
    expect(rule.body).toContain('`assets/` folder next to the page');
    expect(rule.body).toContain('![Approval screen](./assets/approval-screen.png)');
    expect(sharedFileRulesSection(testKbContext().layout)).toContain(rule.body);
    for (const name of ['write_file', 'write_files']) {
      expect(tools.find((t) => t.name === name)!.description, name).not.toContain('`assets/` folder next to the page');
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
    await fs.writeFile(`${KB_DIR}/logo.png`, PNG_1X1);
    const res = await post(`${base}/api/agent/tools/read_file`, { path: `${KB_DIR}/logo.png` });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ImageSentinel;
    expect(body.kind).toBe('bevel/mcp-image@v1');
    expect(body.mimeType).toBe('image/png');
    expect(body.data).toBe(PNG_1X1.toString('base64'));
    expect(body.note).toContain(`${KB_DIR}/logo.png`);
    expect(body.note).toContain('image/png');
    expect(body.note).toContain(`${PNG_1X1.length} bytes`);
    expect(body.note).toContain('1×1 px');
  });

  it('read_file passes a gif through whole under the same cap (first frame is the client’s concern)', async () => {
    const base = await start();
    await fs.writeFile(`${KB_DIR}/anim.gif`, GIF_1X1);
    const body = (await (await post(`${base}/api/agent/tools/read_file`, { path: `${KB_DIR}/anim.gif` })).json()) as ImageSentinel;
    expect(body.kind).toBe('bevel/mcp-image@v1');
    expect(body.mimeType).toBe('image/gif');
    expect(body.data).toBe(GIF_1X1.toString('base64'));
    expect(body.note).toContain('1×1 px');
  });

  it('read_file maps .jpg/.jpeg to image/jpeg (dimensions omitted when the header has none to give)', async () => {
    const base = await start();
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]); // SOI + EOI, no frame header
    await fs.writeFile(`${KB_DIR}/photo.jpg`, bytes);
    const body = (await (await post(`${base}/api/agent/tools/read_file`, { path: `${KB_DIR}/photo.jpg` })).json()) as ImageSentinel;
    expect(body.mimeType).toBe('image/jpeg');
    expect(body.data).toBe(bytes.toString('base64'));
    expect(body.note).toBe(`[image: ${KB_DIR}/photo.jpg — image/jpeg, ${bytes.length} bytes]`);
  });

  it('read_file refuses an image over 3.5 MiB raw with the downscale message, not a sentinel', async () => {
    const base = await start();
    // 3,670,016 is the cap; one byte over must refuse. PNG magic + zero fill.
    const big = Buffer.alloc(3_670_017);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(big);
    await fs.writeFile(`${KB_DIR}/huge.png`, big);
    const res = await post(`${base}/api/agent/tools/read_file`, { path: `${KB_DIR}/huge.png` });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string; content: string };
    expect(body.path).toBe(`${KB_DIR}/huge.png`);
    expect(body.content).toContain('too large to return over MCP');
    expect(body.content).toContain('3670016 bytes');
    expect(body.content).toContain('Downscale');
    expect(body.content).not.toContain(big.toString('base64').slice(0, 40));
  });

  it('read_file keeps .svg on the TEXT path — it is markup, not an image block', async () => {
    const base = await start();
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>';
    await fs.writeFile(`${KB_DIR}/icon.svg`, svg);
    expect(await (await post(`${base}/api/agent/tools/read_file`, { path: `${KB_DIR}/icon.svg` })).json()).toEqual({
      path: `${KB_DIR}/icon.svg`,
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
 * sessionId IS a chat thread). This is what unifies the conversation
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
    // The default branch's workspace directory, for the tests about the
    // `firstRun` note. Without one the workspace service is a bare stand-in
    // the note's check cannot use, which is what every other test here wants:
    // the call answers with the id alone.
    defaultWorkspaceDir?: string,
    // The starter pack the knowledge base was filled from, for the note.
    starterPacks?: FirstRunStarterSource,
    // Who may read what: everything, unless a test about the note's gate says otherwise.
    access: IAccessControl = allowAll,
  ): Promise<string> {
    created = [];
    const registry = new ToolRegistry();
    const resolve = async (auth: ToolAuth, signal: AbortSignal): Promise<ToolContext> => ({
      user: { id: 'user-42', email: 'e@x', name: 'N' },
      scope: auth.scope,
      source: auth.source,
      abortSignal: signal,
      workspaceService: (defaultWorkspaceDir
        ? {
            hasBootstrappedWorkspace: async () => true,
            getWorkspacePath: async () => defaultWorkspaceDir,
          }
        : {}) as never,
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
      new SpillStore(join(tmpdir(), 'bevel-test-spills')), new DocExtractService(join(tmpdir(), 'bevel-test-doc-extract')), access, testKbContext({ kbDirName: KB_DIR }),
      { recoveryBotEmail: RECOVERY_BOT, hooks: new WorkflowHooks(), notes: new ToolDescriptionNotes() },
      new RoutineWritePolicyService(),
      sink ?? fakeSessionSink,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined /* downloads */,
      starterPacks,
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
    const res = (await (await postRaw(`${base}/api/agent/tools/start_session`)).json()) as { sessionId: string };
    expect(res.sessionId).toBe('thread-xyz');
  });

  it('mints the session for the authenticated user', async () => {
    const base = await startSessionApp();
    await postRaw(`${base}/api/agent/tools/start_session`);
    expect(created).toHaveLength(1);
    expect(created[0].userId).toBe('user-42');
    expect(created[0].startedAt).toBeInstanceOf(Date);
  });

  it('rejects an internal-source caller (external-only) so an agent cannot mint a session mid-run', async () => {
    // Note: an OAuth/JWT MCP session is NOT this case — its `externalProxy`
    // loopback token resolves to source 'external' at the verifier (see
    // tool-auth), so it is admitted here like any external agent.
    const base = await startSessionApp('internal');
    const res = await postRaw(`${base}/api/agent/tools/start_session`);
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

      const responses = await Promise.all(Array.from({ length: 50 }, () => postRaw(`${base}/api/agent/tools/start_session`)));
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
        failed = await postRaw(`${base}/api/agent/tools/start_session`);
      } finally {
        errorLog.mockRestore();
      }
      expect(failed.status).toBeGreaterThanOrEqual(500);

      const retried = (await (await postRaw(`${base}/api/agent/tools/start_session`)).json()) as { sessionId: string };
      expect(retried.sessionId).toBe('session-2');
      expect(calls).toBe(2);
    });

    it('gives a retry that lands after a success a NEW id, leaving the first one usable', async () => {
      // The harmless case the description calls out: a client that retries a
      // call which had in fact succeeded ends up holding two ids. Neither
      // supersedes the other — the run keeps using the one it already passed
      // to other tools, and the spare is simply never mentioned again.
      const base = await startSessionApp('external', new UuidSessionSink());

      const first = (await (await postRaw(`${base}/api/agent/tools/start_session`)).json()) as { sessionId: string };
      const retry = (await (await postRaw(`${base}/api/agent/tools/start_session`)).json()) as { sessionId: string };

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
      new SpillStore(join(tmpdir(), 'bevel-test-spills')), new DocExtractService(join(tmpdir(), 'bevel-test-doc-extract')), allowAll, testKbContext({ kbDirName: KB_DIR }),
      { recoveryBotEmail: RECOVERY_BOT, hooks: new WorkflowHooks(), notes: new ToolDescriptionNotes() },
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
    // And that the answer may carry a note to act on, so an agent reading
    // only the catalog knows the field is not noise.
    expect(description).toContain('`firstRun`');
  });

  /**
   * "The agent is the onboarding guide": on a knowledge base nobody has
   * written in yet, the first call of a conversation says so, and the note
   * stops on its own once a page exists.
   */
  describe('the firstRun note', () => {
    let wsDir = '';
    const knowledge = () => join(wsDir, KB_DIR, 'KnowledgeBase');

    beforeEach(async () => {
      wsDir = await mkdtemp(join(tmpdir(), 'bevel-first-run-'));
      await mkdir(knowledge(), { recursive: true });
      await writeFile(join(knowledge(), STARTER_GUIDE_FILE), '# How to get started\n');
    });

    afterEach(async () => {
      await rm(wsDir, { recursive: true, force: true });
    });

    const startSession = async () => {
      const base = await startSessionApp('external', undefined, wsDir);
      // `postRaw`: the tool takes no arguments, and `post` adds a branch.
      return (await (await postRaw(`${base}/api/agent/tools/start_session`)).json()) as { sessionId: string; firstRun?: string };
    };

    it('is there while the knowledge folder holds only the starter guide', async () => {
      // Folder placeholders and access rules are not pages either.
      await mkdir(join(knowledge(), 'Empty'), { recursive: true });
      await writeFile(join(knowledge(), 'Empty', '.gitkeep'), '');
      await writeFile(join(knowledge(), 'access.md'), '# Access\n');

      const res = await startSession();

      expect(res.sessionId).toBe('thread-xyz');
      expect(res.firstRun).toBe(firstRunNote(`${KB_DIR}/KnowledgeBase`));
      expect(res.firstRun).toContain(`\`${FIRST_RUN_SECTION_ID}\``);
    });

    it('is gone once another page exists beside the starter guide', async () => {
      await writeFile(join(knowledge(), 'Glossary.md'), '# Glossary\n');

      const res = await startSession();

      expect(res.sessionId).toBe('thread-xyz');
      expect(res).not.toHaveProperty('firstRun');
    });

    it('is gone once another page exists in a folder', async () => {
      await mkdir(join(knowledge(), 'Company'), { recursive: true });
      await writeFile(join(knowledge(), 'Company', 'About.md'), '# About us\n');

      const res = await startSession();

      expect(res.sessionId).toBe('thread-xyz');
      expect(res).not.toHaveProperty('firstRun');
    });

    it("after a starter pack, stays while the pack's pages are untouched and names its suggestions", async () => {
      await writeFile(join(knowledge(), 'Customers.md'), '# Customers\n');
      const starter: FirstRunStarterSource = {
        firstRunStarter: async () => ({
          name: 'Sales',
          suggestedPages: ['Customers', 'Pricing'],
          pages: new Map([['Customers.md', '# Customers\n']]),
        }),
      };
      const base = await startSessionApp('external', undefined, wsDir, starter);
      const first = (await (await postRaw(`${base}/api/agent/tools/start_session`)).json()) as { firstRun?: string };
      expect(first.firstRun).toBe(
        firstRunNote(`${KB_DIR}/KnowledgeBase`, { name: 'Sales', suggestedPages: ['Customers', 'Pricing'] }),
      );

      await writeFile(join(knowledge(), 'Customers.md'), '# Customers\n\nAcme.\n');
      const second = (await (await postRaw(`${base}/api/agent/tools/start_session`)).json()) as { firstRun?: string };
      expect(second).not.toHaveProperty('firstRun');
    });

    /**
     * The note is a read: it says what the knowledge folder holds. A caller
     * who may not read the folder gets the id alone, and a pack page the
     * caller may not read is judged as anybody's page, so the note never
     * tells them it is still a placeholder.
     */
    it('is withheld from a caller who may not read the knowledge folder', async () => {
      const closed = { ...allowAll, canRead: async () => false } as unknown as IAccessControl;
      const base = await startSessionApp('external', undefined, wsDir, undefined, closed);
      const res = (await (await postRaw(`${base}/api/agent/tools/start_session`)).json()) as { firstRun?: string };
      expect(res).toEqual({ sessionId: 'thread-xyz' });
    });

    it("counts a starter page the caller may not read as somebody's page: no note", async () => {
      await writeFile(join(knowledge(), 'Customers.md'), '# Customers\n');
      const starter: FirstRunStarterSource = {
        firstRunStarter: async () => ({
          name: 'Sales',
          suggestedPages: ['Customers'],
          pages: new Map([['Customers.md', '# Customers\n']]),
        }),
      };
      const pageClosed = {
        ...allowAll,
        canReadBatch: async (_w: string, _u: string, paths: string[]) =>
          new Map(paths.map((p) => [p, !p.endsWith('Customers.md')])),
      } as unknown as IAccessControl;
      const base = await startSessionApp('external', undefined, wsDir, starter, pageClosed);
      const res = (await (await postRaw(`${base}/api/agent/tools/start_session`)).json()) as { firstRun?: string };
      expect(res).toEqual({ sessionId: 'thread-xyz' });
    });

    it('never costs the session id: a workspace it cannot read answers with the id alone', async () => {
      await rm(wsDir, { recursive: true, force: true });

      const res = await startSession();

      expect(res).toEqual({ sessionId: 'thread-xyz' });
    });
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
      testKbContext({ kbDirName: KB_DIR }),
      { recoveryBotEmail: RECOVERY_BOT, hooks: new WorkflowHooks(), notes: new ToolDescriptionNotes() },
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

  it('say the prefix is OPTIONAL, and what an unprefixed path means', async () => {
    await start();
    const tools = await toolRegistry.listInternal();
    const byName = (name: string) => tools.find((t) => t.name === name);
    const said = (name: string, ...keys: string[]) => inputDescription(byName(name), ...keys);
    // Every path input, the ones that used to carry the shorter "may name a
    // stray" wording included: a path without the prefix is PLACED under it,
    // and the description says which path that is.
    for (const name of ['read_file', 'list_files', 'file_stat', 'grep', 'write_file', 'edit_file', 'delete_file', 'mkdir', 'unzip', 'delete_folder']) {
      expect(said(name, 'path'), name).toContain(`placed under \`${KB_DIR}/\``);
    }
    for (const name of ['move_file', 'copy_file']) {
      for (const key of ['src', 'dest']) {
        expect(said(name, key), `${name}.${key}`).toContain(`placed under \`${KB_DIR}/\``);
      }
    }
    expect(said('unzip', 'destination')).toContain(`placed under \`${KB_DIR}/\``);
    expect(inputDescription(byName('write_files'), 'files', 'path')).toContain(`placed under \`${KB_DIR}/\``);
    // And no input still claims a missing prefix is refused.
    for (const name of ['read_file', 'write_file', 'delete_file', 'move_file', 'copy_file', 'unzip']) {
      expect(said(name, 'path') + said(name, 'src') + said(name, 'dest'), name).not.toContain('is refused');
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
 * The MCP tools ACCEPT an unprefixed path now, by placing it inside the
 * checkout, where they used to refuse it with a message naming the corrected
 * spelling. One normaliser does it for all of them, at the tool boundary, so a
 * tool cannot drift from a route again — and the answer names the repository
 * path, so a caller always learns where its bytes went.
 */
describe('the tools place an unprefixed path inside the repository', () => {
  const tool = (base: string, name: string, body: Record<string, unknown>) =>
    post(`${base}/api/agent/tools/${name}`, { branch: 'main', ...body });
  const onDisk = (repoRel: string) => readFile(join(tempDir, KB_DIR, repoRel), 'utf8');
  /** Nothing beside the checkout, ever. */
  const besideCheckout = async () => (await nodeReaddir(tempDir)).filter((n) => n !== KB_DIR).sort();

  it('write_file writes into the repository and reports the repository path', async () => {
    const base = await start();
    const res = await tool(base, 'write_file', { path: 'KnowledgeBase/Report.md', content: 'body' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ path: `${KB_DIR}/KnowledgeBase/Report.md`, outcome: 'created' });
    expect(await onDisk('KnowledgeBase/Report.md')).toBe('body');
    expect(await besideCheckout()).toEqual([]);
  });

  it('write_files places every entry of a batch', async () => {
    const base = await start();
    const res = await tool(base, 'write_files', {
      files: [{ path: 'one.md', content: '1' }, { path: 'Nested/two.md', content: '2' }],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { files: { path: string }[] };
    expect(body.files.map((f) => f.path)).toEqual([`${KB_DIR}/one.md`, `${KB_DIR}/Nested/two.md`]);
    expect(await onDisk('Nested/two.md')).toBe('2');
    expect(await besideCheckout()).toEqual([]);
  });

  it('read_file, file_stat and edit_file all read the same repository file', async () => {
    const base = await start();
    await fs.writeFile(`${KB_DIR}/Notes.md`, 'hello\nworld\n');

    expect(await (await tool(base, 'read_file', { path: 'Notes.md' })).json()).toEqual({
      path: `${KB_DIR}/Notes.md`,
      content: 'hello\nworld\n',
    });
    expect(await (await tool(base, 'file_stat', { path: 'Notes.md' })).json()).toMatchObject({ type: 'file' });
    const edited = await tool(base, 'edit_file', { path: 'Notes.md', old_string: 'world', new_string: 'earth' });
    expect(await edited.json()).toMatchObject({ path: `${KB_DIR}/Notes.md`, replaced: 1 });
    expect(await onDisk('Notes.md')).toBe('hello\nearth\n');
  });

  it('mkdir creates the folder in the repository', async () => {
    const base = await start();
    expect((await tool(base, 'mkdir', { path: 'KnowledgeBase/Reports' })).status).toBe(200);
    expect(await fs.exists(`${KB_DIR}/KnowledgeBase/Reports`)).toBe(true);
    expect(await besideCheckout()).toEqual([]);
  });

  it('move_file and copy_file place both ends', async () => {
    const base = await start();
    await fs.writeFile(`${KB_DIR}/Src/a.md`, 'a');

    expect((await tool(base, 'copy_file', { src: 'Src/a.md', dest: 'Copies/a.md' })).status).toBe(200);
    expect(await onDisk('Copies/a.md')).toBe('a');
    expect((await tool(base, 'move_file', { src: 'Src/a.md', dest: 'Moved/a.md' })).status).toBe(200);
    expect(await onDisk('Moved/a.md')).toBe('a');
    expect(await besideCheckout()).toEqual([]);
  });

  it('delete_file and delete_folder act inside the repository', async () => {
    const base = await start();
    await fs.writeFile(`${KB_DIR}/Doomed/x.md`, 'x');
    expect((await tool(base, 'delete_file', { path: 'Doomed/x.md' })).status).toBe(200);
    expect(await fs.exists(`${KB_DIR}/Doomed/x.md`)).toBe(false);

    await fs.writeFile(`${KB_DIR}/Gone/y.md`, 'y');
    expect((await tool(base, 'delete_folder', { path: 'Gone', confirm: true })).status).toBe(200);
    expect(await fs.exists(`${KB_DIR}/Gone/y.md`)).toBe(false);
  });

  it('unzip hands the service the repository path for archive and destination alike', async () => {
    const base = await start();
    const zip = new AdmZip();
    zip.addFile('in.md', Buffer.from('z'));
    await fs.writeFile(`${KB_DIR}/drop.zip`, zip.toBuffer());

    expect((await tool(base, 'unzip', { path: 'drop.zip', destination: 'Out' })).status).toBe(200);
    expect(unzipCalls).toContainEqual([`${KB_DIR}/drop.zip`, `${KB_DIR}/Out`]);
  });

  it('still refuses the spellings no prefix can rescue, on every tool', async () => {
    const base = await start();
    for (const p of ['../etc/hostname', 'KnowledgeBase\\x', '/tmp/x', 'KnowledgeBase/../../escape.md']) {
      for (const [name, body] of [
        ['read_file', { path: p }],
        ['file_stat', { path: p }],
        ['write_file', { path: p, content: 'x' }],
        ['edit_file', { path: p, old_string: 'a', new_string: 'b' }],
        ['mkdir', { path: p }],
        ['delete_file', { path: p }],
        ['move_file', { src: p, dest: `${KB_DIR}/x.md` }],
        ['copy_file', { src: `${KB_DIR}/a.md`, dest: p }],
        ['unzip', { path: p }],
      ] as [string, Record<string, unknown>][]) {
        const res = await tool(base, name, body);
        expect(res.status, `${name} ${p}`).toBe(400);
        expect((await res.json()).error, `${name} ${p}`).toContain('outside the knowledge base repository');
      }
    }
    expect(await besideCheckout()).toEqual([]);
  });

  it('leaves a spill ref alone — it belongs to no workspace', async () => {
    const base = await start();
    const res = await tool(base, 'read_file', { path: '__tool_chain_spill__/nope.json' });
    // Absent, not refused as a path: the ref reached the spill store as written.
    expect(res.status).not.toBe(400);
  });

  it('gives that exception to read_file alone — for every other tool the ref is a path', async () => {
    // `read_file` is the only tool that consumes a spill ref. Anywhere else,
    // `__tool_chain_spill__/…` is an ordinary string, and leaving it unnormalised
    // would be a workspace-relative path that never reached the repository —
    // beside the checkout, which is the whole bug. So it is placed under the
    // checkout like any other prefix-less path, and names a file that is not there.
    const base = await start();
    const ref = '__tool_chain_spill__/nope.json';
    for (const [name, body] of [
      ['file_stat', { path: ref }],
      ['delete_file', { path: ref }],
      ['copy_file', { src: ref, dest: `${KB_DIR}/copied.md` }],
      ['list_files', { path: ref }],
    ] as [string, Record<string, unknown>][]) {
      const res = await tool(base, name, body);
      const answer = JSON.stringify(await res.json());
      // The answer names the path the tool actually looked at, and it is the
      // one under the checkout — the ref was normalised, not exempted.
      expect(answer, name).toContain(`${KB_DIR}/__tool_chain_spill__`);
      expect(res.status, `${name}: ${answer}`).not.toBe(200);
    }
    // And nothing was written beside the checkout on the way.
    expect(await besideCheckout()).toEqual([]);
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
    // `post` names the branch every KB tool requires; these tests are about
    // folders, not about the branch input.
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
    // Beside the checkout on purpose — a clone OF it, not content in it — so it
    // is read from disk rather than through a workspace path.
    expect((await stat(join(tempDir, 'fresh-clone', 'nested', 'level-two'))).isDirectory()).toBe(true);
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

    expect((await names(base, KB(''))).sort()).toEqual(['a.md:file', 'from:directory', 'to:directory']);
    expect(await names(base, KB('from'))).toEqual([]);
    await expect(fs.exists(KB('from/.gitkeep'))).resolves.toBe(true);
  });

  it('mkdir, a nested write, and an emptied folder converge on the same state', async () => {
    const base = await start();
    await tool(base, 'mkdir', { path: KB('Made') });
    await tool(base, 'write_file', { path: KB('Written/n.md'), content: 'n' });

    expect((await names(base, KB(''))).sort()).toEqual(['Made:directory', 'Written:directory', 'a.md:file']);
    expect(await names(base, KB('Made'))).toEqual([]);

    await tool(base, 'delete_file', { path: KB('Written/n.md') });
    expect((await names(base, KB(''))).sort()).toEqual(['Made:directory', 'Written:directory', 'a.md:file']);
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
    // This double has no access files to carry, so the destination as it will
    // be IS the destination as it is — the answer `accessAt` gave before the
    // preview learned to relocate them, which keeps every ordering and
    // oracle test below about what it is about.
    previewAccessAfterRelocation: async (_w: string, _u: string, _from: string, to: string) => verbsFor(to),
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

    /**
     * The dry run keeps that order too, and it is the easier oracle to reach:
     * it answers 200 rather than throwing, so a denied caller could read the
     * source's kind and its file count off it — or a 404 saying whether a
     * source they may not copy from exists at all. Nothing on disk is probed
     * until the write verdict on the destination has been taken.
     */
    it('copy_file\'s dry run refuses a denied destination the same way whatever the source is', async () => {
      const base = await seeded();
      const dry = async (src: string) =>
        (await call(base, 'copy_file', { src, dest: KB('Locked/new.md'), dryRun: true })).body;

      const file = await dry(KB('Sales/deal.md'));
      const folder = await dry(KB('Sales/archive'));
      const missing = await dry(KB('Sales/nothing-here.md'));

      // One sentence, three sources: the refusal says nothing about any of them.
      for (const answer of [file, folder, missing]) {
        expect(answer).toMatchObject({ allowed: false, dryRun: true, copied: false });
        expect(answer.reason).toContain(KB('Locked/new.md'));
        expect(answer.kind).toBeUndefined();
        expect(answer.descendants).toBeUndefined();
      }
      expect(folder.reason).toBe(file.reason);
      expect(missing.reason).toBe(file.reason);
      // And the caller's own verbs are still answered — those are theirs.
      expect(Object.keys(file.access).sort()).toEqual(['after', 'before']);
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

    it('every one of the three platform files gets the same sentence, and the agent never gets the admin restore', async () => {
      // The agent move tool has no exception: the recovery move is a person's,
      // made as an admin, and an agent is neither.
      const base = await seeded();
      await fs.writeFile(KB('roles.yaml'), 'roles: {}\n');
      await fs.writeFile(KB('.bevelignore'), '*.tmp\n');
      await fs.writeFile(KB('Misplaced/access.md'), '---\nread: everyone\n---\n');
      const cases: [string, string][] = [
        [KB('access.md'), KB('Sales/access.md')],
        [KB('roles.yaml'), KB('Sales/roles.yaml')],
        [KB('.bevelignore'), KB('Sales/.bevelignore')],
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

    // A nested access.md is deleted the way a person deletes it in the app:
    // by whoever may write it, through the same one-file delete (the locking
    // filesystem's, which commits and pushes as the caller) as any file.
    it('a nested access.md is deleted by a caller who may write it, like any file', async () => {
      const base = await seeded();
      await fs.writeFile(KB('Sales/access.md'), '---\nread: Admin\n---\n');
      expect((await call(base, 'file_stat', { path: KB('Sales/access.md') })).body).toMatchObject({
        managed: true, movable: false, deletable: true,
      });
      const deleted: string[] = [];
      const deleteFile = fs.deleteFile.bind(fs);
      fs.deleteFile = async (p: string) => { deleted.push(p); return deleteFile(p); };

      const run = await call(base, 'delete_file', { path: KB('Sales/access.md') });

      expect(run.status).toBe(200);
      expect(run.body).toEqual({ path: KB('Sales/access.md'), deleted: true });
      expect(deleted).toEqual([KB('Sales/access.md')]);
      expect(await exists(KB('Sales/access.md'))).toBe(false);
      expect(await exists(KB('Sales/deal.md'))).toBe(true);
    });

    it('a nested access.md the caller may not write is the ordinary write refusal, and stays', async () => {
      const base = await seeded();
      await fs.writeFile(KB('Locked/access.md'), '---\nread: everyone\n---\n');
      expect((await call(base, 'file_stat', { path: KB('Locked/access.md') })).body).toMatchObject({
        managed: true, deletable: false,
      });

      const run = await call(base, 'delete_file', { path: KB('Locked/access.md') });

      expect(run.status).toBe(403);
      expect(run.body).toMatchObject({ kind: 'write-denied', path: KB('Locked/access.md'), canPropose: true });
      expect(JSON.stringify(run.body)).not.toContain('platform file');
      expect(await exists(KB('Locked/access.md'))).toBe(true);
    });

    it('the root access.md and roles.yaml are the repository\'s own: refused for everyone, and they stay', async () => {
      const base = await seeded();
      await fs.writeFile(KB('roles.yaml'), 'roles: {}\n');
      for (const name of ['access.md', 'roles.yaml']) {
        // The caller here may write and own everything: the refusal is not about who asks.
        expect((await call(base, 'file_stat', { path: KB(name) })).body).toMatchObject({
          managed: true, movable: false, deletable: false,
          access: { read: true, write: true, download: true, owner: true },
        });
        const run = await call(base, 'delete_file', { path: KB(name) });
        expect(run.status).toBe(400);
        expect(run.body.error).toBe(`${name} is the repository's own file and cannot be deleted.`);
        expect(await exists(KB(name))).toBe(true);
      }
    });

    it('a nested roles.yaml is content, and .bevelignore stays refused as before', async () => {
      const base = await seeded();
      await fs.writeFile(KB('Sales/roles.yaml'), 'content');
      await fs.writeFile(KB('Sales/.bevelignore'), '*.tmp\n');
      expect((await call(base, 'delete_file', { path: KB('Sales/roles.yaml') })).status).toBe(200);
      const ignore = await call(base, 'delete_file', { path: KB('Sales/.bevelignore') });
      expect(ignore.status).toBe(400);
      expect(ignore.body.error).toBe('.bevelignore is a platform file and cannot be deleted through the agent tools.');
      expect((await call(base, 'file_stat', { path: KB('Sales/.bevelignore') })).body).toMatchObject({ deletable: false });
    });

    it('delete_folder still refuses the repository root, which keeps its access.md', async () => {
      const base = await seeded();
      for (const args of [{ dryRun: true }, { confirm: true }]) {
        const run = await call(base, 'delete_folder', { path: KB_DIR, ...args });
        expect(run.body.allowed === false || run.status === 400).toBe(true);
        expect(JSON.stringify(run.body)).toContain('The repository root is a platform folder and cannot be moved or deleted.');
      }
      expect(await exists(KB('access.md'))).toBe(true);
    });
  });

  describe('what counts as the platform\'s own, and what a move or delete may reach', () => {
    const caseSensitiveDisk = process.platform === 'linux';

    it('roles.yaml is a platform file only at the root; access.md and .bevelignore at any depth; AGENTS.md nowhere', async () => {
      const base = await seeded();
      await fs.writeFile(KB('roles.yaml'), 'roles: {}\n');
      await fs.writeFile(KB('Sales/roles.yaml'), 'content');
      await fs.writeFile(KB('AGENTS.md'), 'content');
      await fs.writeFile(KB('Sales/AGENTS.md'), 'content');
      await fs.writeFile(KB('Sales/.bevelignore'), '*.tmp\n');
      const managed = async (p: string) => (await call(base, 'file_stat', { path: KB(p) })).body.managed;
      expect(await managed('roles.yaml')).toBe(true);
      expect(await managed('Sales/roles.yaml')).toBe(false);
      // The organisation's own conventions file: the guide is served from
      // code, so nothing under this name is the platform's.
      expect(await managed('AGENTS.md')).toBe(false);
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
      // `file_stat` used to answer with a body saying the path was neither
      // movable nor deletable. The normaliser refuses the spelling before the
      // tool runs at all now, which is the stronger answer: nothing is judged
      // under a path that names one folder and opens another.
      const stat = await call(base, 'file_stat', { path: KB('Sales/./deal.md') });
      expect(stat.status).toBe(400);
      expect(stat.body.error).toContain('"." or ".." segments');
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
      // What refuses a move, and the dry-run/confirm protocol it shares with the
      // deletes, are shared rules — stated once, in the two shared places.
      const rules = sharedFileRulesSection(testKbContext().layout);
      expect(rules).toContain('is a platform file and stays in its folder.');
      expect(rules).toContain('`dryRun: true`');
      expect(rules).toContain('`confirm: true`');
      expect(d.description).toContain('`confirm: true`');
      expect(Object.keys(d.inputs.properties.body.properties)).toEqual(expect.arrayContaining(['dryRun', 'confirm']));
      // What the description promises a dry run returns is what it returns.
      const dry = await call(base, 'move_file', { src: KB('Sales/deal.md'), dest: KB('HR/deal.md'), dryRun: true });
      for (const key of ['src', 'dest', 'kind', 'descendants', 'access', 'accessChanges', 'allowed']) {
        expect(d.description, key).toContain(key);
        expect(dry.body, key).toHaveProperty(key);
      }
      const unconfirmed = await call(base, 'move_file', { src: KB('Sales/deal.md'), dest: KB('HR/deal.md') });
      // What an unconfirmed call answers is the shared protocol's promise; the
      // field is still declared in this tool's own `outputs`.
      expect(rules).toContain('confirmationRequired: true');
      expect(declaredOutputs(d)).toContain('confirmationRequired');
      expect(unconfirmed.body.confirmationRequired).toBe(true);
      for (const body of [dry.body, unconfirmed.body]) {
        expect(declaredOutputs(d)).toEqual(expect.arrayContaining(Object.keys(body)));
      }
    });

    it('delete_folder states the confirm rule and refusals, and declares every field it returns', async () => {
      const base = await seeded();
      const d = await def('delete_folder');
      expect(d.description).toContain('a non-empty folder wants `confirm: true`');
      // The protocol itself, and what a platform folder does to it, are shared.
      const rules = sharedFileRulesSection(testKbContext().layout);
      expect(rules).toContain('`dryRun: true`');
      expect(rules).toContain('A non-empty folder is deleted, and a move that changes your access runs, only with `confirm: true`');
      expect(rules).toContain('platform folder');
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
      expect(stat.description).toContain('shared rules on what these tools never move or delete');
      // The proposal route applies to every tool a permission can refuse, so it
      // is stated once in the shared rules rather than on each of them.
      expect(sharedFileRulesSection(testKbContext().layout)).toContain('`write-denied`');
      for (const name of ['move_file', 'delete_file', 'delete_folder']) {
        expect((await def(name)).description.startsWith(GUIDE_FIRST_SENTENCE), name).toBe(true);
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
      previewAccessAfterRelocation: async () => ({ read: true, write: true, download: true, owner: true }),
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
    for (const m of ['writeFile', 'rewriteFile', 'deleteFile', 'moveFile', 'mkdir']) target[m] = refuse;
    target.copyFile = async (_src: string, dest: string) => refuse(dest);
    // `delete_folder` lands through the same batch with NO writes and the
    // folder's files as `deletes` — in production the refusal comes from the
    // lock it takes on one of them, so the denial names that file.
    target.writeFiles = async (writes: { path: string }[], _summary?: string, deletes?: string[]) =>
      refuse(writes[0]?.path ?? deletes?.[0]);
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
    // The folder HOLDING the denied file: confirmed, so the call goes past the
    // impact preflight and reaches the gate that refuses.
    ['delete_folder', { branch: TARGET, path: `${KB_DIR}/Sales`, confirm: true }],
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
    // An EMPTY folder needs no batch, so it would never reach the gate: put the
    // denied file back (past the refusing stub, straight to disk) whatever the
    // case before it did.
    if (tool === 'delete_folder') await writeFile(join(tempDir, DENIED), 'old text\n');
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

  it('states the proposal route in the shared rules, not in each write tool description', async () => {
    await start();
    const tools = await toolRegistry.listInternal();
    // It applies to every tool a permission can refuse, so it is a shared rule:
    // stated in the handshake instructions and in the managed guide, and in no
    // description. The refusal ITSELF still spells the steps out — that is what
    // the tests above this one assert.
    const rule = sharedFileRules(testKbContext().layout).find((r) => r.id === 'refused-for-permissions')!;
    expect(sharedFileRulesSection(testKbContext().layout)).toContain(rule.body);
    for (const def of tools) {
      expect(def.description ?? '', def.name).not.toContain('If this is refused for permissions');
      expect(def.description ?? '', def.name).not.toContain(rule.body);
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

  // A backslash is a filename character on THIS disk and a separator on
  // Windows, so it is a path nobody can read the same way twice. The read tools
  // used to meet it as plain absence; the one normaliser refuses it up front
  // now, on every tool alike — the refusal the move and delete tools always
  // gave, extended to the rest by the fact that they all go through it.
  it('a malformed path: backslashes are refused up front, on every tool', async () => {
    const base = await start();
    const odd = `${KB_DIR}\\Knowledge\\NoSuchFile.md`;
    const tools: [string, Record<string, unknown>][] = [
      ...callsFor(odd).filter(([name]) => ['read_file', 'file_stat', 'grep', 'edit_file', 'copy_file'].includes(name)),
      ['delete_file', { path: odd }],
      ['move_file', { src: odd, dest: `${FOLDER}/Moved.md` }],
    ];
    for (const [tool, body] of tools) {
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

/**
 * The neutral session hooks, through the tool routes.
 *
 * Hexis decides nothing about which paths a conversation may touch: it calls a
 * registered hook before every agent read and every agent write of a
 * knowledge-base path, hands it what it knows about the call, and lets a hook
 * that throws refuse the operation with its own message and status. With no
 * hook registered — every Hexis-only deployment — nothing is refused, nothing
 * is recorded, and a call without a `sessionId` is an ordinary call.
 */
describe('agent read/write hooks', () => {
  /** Every call the read hook saw, in order. */
  let reads: AgentOperationContext[];
  /** Every call the write hook saw, in order. */
  let writes: AgentOperationContext[];

  /** Register recording hooks on the mounted registry (after `start()`). */
  const record = (): void => {
    reads = [];
    writes = [];
    hooks.onAgentRead(async (op) => {
      reads.push(op);
    });
    hooks.onPreWrite(async (op) => {
      writes.push(op);
    });
  };

  /** Register a write hook that refuses `path` (or every path) with a 403. */
  const refuseWrites = (message: string, path?: string): void => {
    hooks.onPreWrite(async (op) => {
      if (path === undefined || op.wsPath === path) throw new ToolError(message, 403);
    });
  };

  beforeEach(() => {
    reads = [];
    writes = [];
  });

  it('read_file calls the read hook once with the session, path, branch, user and source', async () => {
    const base = await start();
    record();
    await fs.mkdir(`${KB_DIR}/KnowledgeBase/Product/Knowledge`, { recursive: true });
    await fs.writeFile(`${KB_DIR}/KnowledgeBase/Product/Knowledge/Roadmap.md`, 'plans');
    const res = await post(`${base}/api/agent/tools/read_file`, {
      branch: 'draft-1',
      path: `${KB_DIR}/KnowledgeBase/Product/Knowledge/Roadmap.md`,
      sessionId: 's1',
    });
    expect(res.status).toBe(200);
    expect(reads).toEqual([
      {
        sessionId: 's1',
        wsPath: `${KB_DIR}/KnowledgeBase/Product/Knowledge/Roadmap.md`,
        branch: 'draft-1',
        user: { id: 'u', email: 'e@x', name: 'N' },
        source: 'internal',
      },
    ]);
    expect(writes).toEqual([]);
  });

  it("file_stat at the guide's name tells the read hook once when it reads the organisation's own file, and never for the guide alone", async () => {
    guideText = 'THE PLATFORM GUIDE\n';
    const base = await start();
    record();
    // Nothing of the organisation's there: the guide is everyone's and no
    // file is read, so the hook hears nothing.
    expect((await post(`${base}/api/agent/tools/file_stat`, { path: `${KB_DIR}/AGENTS.md`, sessionId: 's1' })).status).toBe(200);
    expect(reads).toEqual([]);
    // The organisation's own file: telling it from a stale copy reads it,
    // and the hook hears of that read exactly once — as it does of a read_file.
    await fs.writeFile(`${KB_DIR}/AGENTS.md`, '# Acme\n');
    expect((await post(`${base}/api/agent/tools/file_stat`, { path: `${KB_DIR}/AGENTS.md`, sessionId: 's1' })).status).toBe(200);
    expect(reads.map((op) => op.wsPath)).toEqual([`${KB_DIR}/AGENTS.md`]);
    // A stale copy of the guide is read to be recognised, so it is heard of too.
    await fs.writeFile(`${KB_DIR}/AGENTS.md`, '# Knowledge base\n\n> **This file is managed by the platform.** Stale.\n');
    expect((await post(`${base}/api/agent/tools/file_stat`, { path: `${KB_DIR}/AGENTS.md`, sessionId: 's1' })).status).toBe(200);
    expect(reads.map((op) => op.wsPath)).toEqual([`${KB_DIR}/AGENTS.md`, `${KB_DIR}/AGENTS.md`]);
  });

  it("grep at the guide's name tells the read hook the same way: never for the guide alone, once for the organisation's own file", async () => {
    guideText = 'THE PLATFORM GUIDE\n';
    const base = await start();
    record();
    // The guide alone: nothing of the organisation's is read, so the hook
    // hears nothing — a search of the guide's path is not a read of a file.
    expect((await post(`${base}/api/agent/tools/grep`, { pattern: 'GUIDE', path: `${KB_DIR}/AGENTS.md`, sessionId: 's1' })).status).toBe(200);
    expect(reads).toEqual([]);
    // The organisation's own file: once, as read_file tells it — not once
    // for the search root and again for the file.
    await fs.writeFile(`${KB_DIR}/AGENTS.md`, '# Acme GUIDE\n');
    expect((await post(`${base}/api/agent/tools/grep`, { pattern: 'GUIDE', path: `${KB_DIR}/AGENTS.md`, sessionId: 's1' })).status).toBe(200);
    expect(reads.map((op) => op.wsPath)).toEqual([`${KB_DIR}/AGENTS.md`]);
    // A search of the whole knowledge base: the root once, then each file the
    // walk opens once — the own AGENTS.md among them exactly once, from the
    // composed search, never again from the walk.
    reads = [];
    expect((await post(`${base}/api/agent/tools/grep`, { pattern: 'GUIDE', sessionId: 's1' })).status).toBe(200);
    expect(reads[0]?.wsPath).toBe(KB_DIR);
    expect(reads.filter((op) => op.wsPath === `${KB_DIR}/AGENTS.md`)).toHaveLength(1);
  });

  it('the read hook covers list_files, file_stat, grep, delete_file and delete_folder', async () => {
    const base = await start();
    record();
    await fs.mkdir(`${KB_DIR}/Folder`, { recursive: true });
    await fs.writeFile(`${KB_DIR}/Folder/one.md`, 'needle');
    await fs.writeFile(`${KB_DIR}/gone.md`, 'x');
    await post(`${base}/api/agent/tools/list_files`, { path: `${KB_DIR}/Folder`, sessionId: 's1' });
    await post(`${base}/api/agent/tools/file_stat`, { path: `${KB_DIR}/Folder/one.md`, sessionId: 's1' });
    await post(`${base}/api/agent/tools/grep`, { pattern: 'needle', path: `${KB_DIR}/Folder`, sessionId: 's1' });
    await post(`${base}/api/agent/tools/delete_file`, { path: `${KB_DIR}/gone.md`, sessionId: 's1' });
    await post(`${base}/api/agent/tools/delete_folder`, { path: `${KB_DIR}/Folder`, confirm: true, sessionId: 's1' });
    const paths = reads.map((r) => r.wsPath);
    expect(paths).toContain(`${KB_DIR}/Folder`);
    expect(paths).toContain(`${KB_DIR}/Folder/one.md`);
    expect(paths).toContain(`${KB_DIR}/gone.md`);
    // A delete carries no bytes from elsewhere, so it is a read, never a write.
    expect(writes).toEqual([]);
  });

  it('grep tells the read hook about every file the walk opens, not only its root', async () => {
    const base = await start();
    record();
    await fs.mkdir(`${KB_DIR}/KnowledgeBase/Product/Knowledge`, { recursive: true });
    await fs.mkdir(`${KB_DIR}/KnowledgeBase/Legal/Knowledge`, { recursive: true });
    await fs.writeFile(`${KB_DIR}/KnowledgeBase/Product/Knowledge/P.md`, 'needle');
    await fs.writeFile(`${KB_DIR}/KnowledgeBase/Legal/Knowledge/L.md`, 'needle');
    await post(`${base}/api/agent/tools/grep`, { pattern: 'needle', path: KB_DIR, sessionId: 's1' });
    const paths = reads.map((r) => r.wsPath);
    expect(paths).toContain(`${KB_DIR}/KnowledgeBase/Product/Knowledge/P.md`);
    expect(paths).toContain(`${KB_DIR}/KnowledgeBase/Legal/Knowledge/L.md`);
  });

  it('the write hook covers write_file, edit_file and mkdir, once per path', async () => {
    const base = await start();
    record();
    await post(`${base}/api/agent/tools/write_file`, { path: `${KB_DIR}/new.md`, content: 'hi', sessionId: 's1' });
    await post(`${base}/api/agent/tools/edit_file`, { path: `${KB_DIR}/a.md`, old_string: 'world', new_string: 'earth', sessionId: 's1' });
    await post(`${base}/api/agent/tools/mkdir`, { path: `${KB_DIR}/dir`, sessionId: 's1' });
    expect(writes.map((w) => w.wsPath)).toEqual([`${KB_DIR}/new.md`, `${KB_DIR}/a.md`, `${KB_DIR}/dir`]);
    expect(writes.every((w) => w.sessionId === 's1' && w.branch === 'main')).toBe(true);
  });

  it('move_file and copy_file call the write hook for the source path AND the destination', async () => {
    const base = await start();
    record();
    await fs.writeFile(`${KB_DIR}/src.md`, 'body');
    await fs.writeFile(`${KB_DIR}/copy-me.md`, 'body');
    await post(`${base}/api/agent/tools/move_file`, { src: `${KB_DIR}/src.md`, dest: `${KB_DIR}/moved.md`, confirm: true, sessionId: 's1' });
    await post(`${base}/api/agent/tools/copy_file`, { src: `${KB_DIR}/copy-me.md`, dest: `${KB_DIR}/copied.md`, sessionId: 's1' });
    expect(writes.map((w) => w.wsPath)).toEqual([
      `${KB_DIR}/src.md`,
      `${KB_DIR}/moved.md`,
      `${KB_DIR}/copy-me.md`,
      `${KB_DIR}/copied.md`,
    ]);
  });

  it('unzip reads the archive and calls the write hook once per extracted entry', async () => {
    const base = await start();
    record();
    await fs.writeFile(`${KB_DIR}/a.zip`, 'not-really-a-zip');
    unzipEntries = [`${KB_DIR}/out/one.md`, `${KB_DIR}/out/two.md`];
    const res = await post(`${base}/api/agent/tools/unzip`, { path: `${KB_DIR}/a.zip`, sessionId: 's1' });
    expect(res.status).toBe(200);
    expect(reads.map((r) => r.wsPath)).toEqual([`${KB_DIR}/a.zip`]);
    expect(writes.map((w) => w.wsPath)).toEqual([`${KB_DIR}/out/one.md`, `${KB_DIR}/out/two.md`]);
  });

  it('execute_command calls the write hook once, with no path', async () => {
    const base = await start();
    record();
    await post(`${base}/api/agent/tools/execute_command`, { branch: 'main', command: 'echo hi', sessionId: 's1' });
    expect(writes).toHaveLength(1);
    expect(writes[0].wsPath).toBeUndefined();
    expect(writes[0]).toMatchObject({ sessionId: 's1', branch: 'main', source: 'internal' });
    expect(reads).toEqual([]);
  });

  it('a write hook that throws refuses the write with its own message and status, and the file is unchanged', async () => {
    const base = await start();
    record();
    refuseWrites('Not in this conversation.');
    const res = await post(`${base}/api/agent/tools/write_file`, {
      path: `${KB_DIR}/a.md`,
      // `overwrite`, so the unchanged file below is the hook's doing: with no
      // hook this call WOULD replace `a.md`.
      mode: 'overwrite',
      content: 'clobbered',
      sessionId: 's1',
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('Not in this conversation.');
    expect(await readFile(join(tempDir, `${KB_DIR}/a.md`), 'utf8')).toBe('hello\nworld\n');
  });

  it('a read hook that throws refuses the read with its own message and status', async () => {
    const base = await start();
    hooks.onAgentRead(async () => {
      throw new ToolError('Not in this conversation.', 403);
    });
    const res = await post(`${base}/api/agent/tools/read_file`, { path: `${KB_DIR}/a.md`, sessionId: 's1' });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('Not in this conversation.');
  });

  it('write_files reports the refused path only; the other two land', async () => {
    const base = await start();
    record();
    refuseWrites('Not in this conversation.', `${KB_DIR}/two.md`);
    const res = await post(`${base}/api/agent/tools/write_files`, {
      files: [
        { path: `${KB_DIR}/one.md`, content: '1' },
        { path: `${KB_DIR}/two.md`, content: '2' },
        { path: `${KB_DIR}/three.md`, content: '3' },
      ],
      sessionId: 's1',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { count: number; files: { path: string; outcome: string; message?: string }[] };
    expect(body.files.map((f) => f.outcome)).toEqual(['created', 'refused', 'created']);
    expect(body.files[1].message).toBe('Not in this conversation.');
    expect(body.count).toBe(2);
    expect(await readFile(join(tempDir, `${KB_DIR}/one.md`), 'utf8')).toBe('1');
    expect(await readFile(join(tempDir, `${KB_DIR}/three.md`), 'utf8')).toBe('3');
  });

  it('a write hook that fails unexpectedly fails the whole write_files batch, rather than reading as a refusal', async () => {
    const base = await start();
    record();
    // Not a ToolError: the hook did not JUDGE this path, the gate itself
    // broke. Reporting that as `refused` would let the other paths commit
    // past a gate that never ran.
    hooks.onPreWrite(async (op) => {
      if (op.wsPath === `${KB_DIR}/two.md`) throw new Error('the hook store is down');
    });
    const res = await post(`${base}/api/agent/tools/write_files`, {
      files: [
        { path: `${KB_DIR}/one.md`, content: '1' },
        { path: `${KB_DIR}/two.md`, content: '2' },
        { path: `${KB_DIR}/three.md`, content: '3' },
      ],
      sessionId: 's1',
    });
    expect(res.status).toBe(500);
    for (const name of ['one.md', 'two.md', 'three.md']) {
      await expect(readFile(join(tempDir, `${KB_DIR}/${name}`), 'utf8')).rejects.toThrow();
    }
  });

  it('unzip skips the refused entry with the hook\'s message and extracts the others', async () => {
    const base = await start();
    record();
    await fs.writeFile(`${KB_DIR}/a.zip`, 'not-really-a-zip');
    unzipEntries = [`${KB_DIR}/out/keep.md`, `${KB_DIR}/out/blocked.md`, `${KB_DIR}/out/also-keep.md`];
    refuseWrites('Not in this conversation.', `${KB_DIR}/out/blocked.md`);
    const res = await post(`${base}/api/agent/tools/unzip`, { path: `${KB_DIR}/a.zip`, sessionId: 's1' });
    const body = (await res.json()) as { extracted: string[]; skipped: { path: string; reason: string }[] };
    expect(body.extracted).toEqual([`${KB_DIR}/out/keep.md`, `${KB_DIR}/out/also-keep.md`]);
    expect(body.skipped).toEqual([{ path: `${KB_DIR}/out/blocked.md`, reason: 'Not in this conversation.' }]);
  });

  it('a hook is called with no session id when the call carried none — what happens next is its decision', async () => {
    const base = await start();
    record();
    await post(`${base}/api/agent/tools/read_file`, { path: `${KB_DIR}/a.md` });
    await post(`${base}/api/agent/tools/write_file`, { path: `${KB_DIR}/fresh.md`, content: 'x' });
    expect(reads).toHaveLength(1);
    expect(reads[0].sessionId).toBeUndefined();
    expect(writes).toHaveLength(1);
    expect(writes[0].sessionId).toBeUndefined();
  });

  it('a person saving in the app never reaches the hooks', async () => {
    const base = await start();
    record();
    callerSource = 'session';
    await post(`${base}/api/agent/tools/read_file`, { path: `${KB_DIR}/a.md`, sessionId: 's1' });
    await post(`${base}/api/agent/tools/write_file`, { path: `${KB_DIR}/fresh.md`, content: 'x', sessionId: 's1' });
    expect(reads).toEqual([]);
    expect(writes).toEqual([]);
  });

  it('the recovery bot never reaches the hooks', async () => {
    const base = await start('write', allowAll, RECOVERY_BOT);
    record();
    refuseWrites('Not in this conversation.');
    const res = await post(`${base}/api/agent/tools/write_file`, { path: `${KB_DIR}/fresh.md`, content: 'x', sessionId: 's1' });
    expect(res.status).toBe(200);
    expect(reads).toEqual([]);
    expect(writes).toEqual([]);
  });

  /**
   * The Hexis-only deployment: nothing registered at all. No call is refused,
   * and a file tool call without a `sessionId` succeeds — including one that
   * read under two different folders first.
   */
  it('with no hook registered, reads and writes without a sessionId all succeed', async () => {
    const base = await start();
    await fs.mkdir(`${KB_DIR}/KnowledgeBase/Product/Knowledge`, { recursive: true });
    await fs.mkdir(`${KB_DIR}/KnowledgeBase/Legal/Knowledge`, { recursive: true });
    await fs.writeFile(`${KB_DIR}/KnowledgeBase/Product/Knowledge/P.md`, 'p');
    await fs.writeFile(`${KB_DIR}/KnowledgeBase/Legal/Knowledge/L.md`, 'l');
    expect((await post(`${base}/api/agent/tools/read_file`, { path: `${KB_DIR}/KnowledgeBase/Product/Knowledge/P.md` })).status).toBe(200);
    expect((await post(`${base}/api/agent/tools/read_file`, { path: `${KB_DIR}/KnowledgeBase/Legal/Knowledge/L.md` })).status).toBe(200);
    const wrote = await post(`${base}/api/agent/tools/write_file`, {
      path: `${KB_DIR}/KnowledgeBase/Product/Knowledge/New.md`,
      content: 'fresh',
    });
    expect(wrote.status).toBe(200);
    expect(await readFile(join(tempDir, `${KB_DIR}/KnowledgeBase/Product/Knowledge/New.md`), 'utf8')).toBe('fresh');
  });
});

/**
 * What an agent READS about these tools. A Hexis-only deployment names no
 * boundary and no ontology; a deployment that has one registers the wording
 * for it, and it lands on the gated tools and on the `sessionId` input.
 */
describe('tool descriptions and the deployment note', () => {
  /** Every tool def on the external surface, by name. */
  const defs = async (): Promise<Map<string, { description: string; inputs: unknown }>> =>
    new Map((await toolRegistry.listExternal()).map((t) => [t.name, t as unknown as { description: string; inputs: unknown }]));

  /** The `sessionId` input's description on a built def, or undefined. */
  const sessionIdDescriptionOf = (def: { inputs: unknown }): string | undefined =>
    (def.inputs as { properties?: { body?: { properties?: Record<string, { description?: string }> } } })
      .properties?.body?.properties?.sessionId?.description;

  it('no tool description and no input description contains the word "ontology"', async () => {
    await start();
    for (const tool of await toolRegistry.listExternal()) {
      expect(tool.description.toLowerCase(), `${tool.name} description`).not.toContain('ontolog');
      expect(JSON.stringify(tool.inputs).toLowerCase(), `${tool.name} inputs`).not.toContain('ontolog');
    }
  });

  it('start_session says what the id is — the conversation\'s, shared with `ask` — and names no ontology', async () => {
    await start();
    const description = (await defs()).get('start_session')?.description ?? '';
    expect(description).toMatch(/conversation/i);
    expect(description).toContain('`ask`');
    expect(description.toLowerCase()).not.toContain('ontolog');
  });

  it('the file tools still accept a sessionId, described as this conversation\'s id', async () => {
    await start();
    const all = await defs();
    for (const name of ['read_file', 'write_file', 'edit_file', 'grep', 'unzip']) {
      expect(sessionIdDescriptionOf(all.get(name)!), name).toBe(SESSION_ID_DESCRIPTION);
    }
  });

  it('a Hexis-only deployment registers no note, so nothing is appended', async () => {
    await start();
    const all = await defs();
    expect(notes.gatedToolNote()).toBe('');
    expect(all.get('read_file')!.description).not.toContain('Stay within one');
  });

  it("a registered note lands after every gated tool's own text, behind the guide-first opening, and on the sessionId input", async () => {
    await start();
    notes.registerGatedToolNote(' One folder per conversation.');
    notes.registerSessionIdNote(' It also pins that folder.');
    const all = await defs();
    // The guide-first sentence is FIRST, always: that is the one instruction
    // an agent needs, and a description cut short from the end must not lose
    // it. The deployment's note is last, after the tool's own text.
    for (const name of ['read_file', 'list_files', 'file_stat', 'grep', 'write_file', 'write_files', 'edit_file', 'delete_file', 'delete_folder', 'mkdir', 'move_file', 'copy_file', 'unzip']) {
      expect(all.get(name)!.description.startsWith(`${GUIDE_FIRST_SENTENCE} `), name).toBe(true);
      expect(all.get(name)!.description.endsWith(' One folder per conversation.'), name).toBe(true);
      expect(sessionIdDescriptionOf(all.get(name)!), name).toBe(`${SESSION_ID_DESCRIPTION} It also pins that folder.`);
    }
    // `execute_command` is internal-only, so it is checked on that surface.
    const internal = new Map((await toolRegistry.listInternal()).map((t) => [t.name, t]));
    expect(internal.get('execute_command')!.description.endsWith(' One folder per conversation.')).toBe(true);
  });

  it('a tool that is not gated carries no note', async () => {
    await start();
    notes.registerGatedToolNote(' One folder per conversation.');
    const description = (await defs()).get('start_session')?.description ?? '';
    expect(description).not.toContain('One folder per conversation.');
  });
});

/**
 * The bug Juan reported: the dry run of renaming a top-level folder warned he
 * would lose owner access, and after the move he was still owner. The folder
 * carried its own `access.md`, which moved with it, and the preview judged
 * the destination as it stood — where neither the folder nor its rules were
 * yet.
 *
 * These run against the REAL resolver over a real tree, because the thing
 * under test is what the rules say about a path nothing is at. Every preview
 * is then held against the operation it predicted: the caller's access at the
 * destination afterwards must be what the preview answered, or the preview is
 * wrong again and nobody will find out until the next report.
 */
describe('a move preview judges the destination as it will be', () => {
  const KB = (p: string) => `${KB_DIR}/${p}`;
  const MOVER = 'mover@x.io';
  const rules = (body: string) => `---\n${body}---\n`;

  /**
   * The real `AccessControlService`, re-read from disk on every question.
   * In production the file-change notifier invalidates the model after a
   * write; a test leaning on the five-second cache would be asserting the
   * cache rather than what the tree now says.
   */
  const liveRules = (): IAccessControl => {
    const fresh = () =>
      new AccessControlService(
        {
          getWorkspacePath: async () => tempDir,
          ensureRemotesFetched: async () => undefined,
        } as unknown as WorkspaceService,
        KB_DIR,
        new NodeFs(),
      );
    return {
      canRead: (w: string, u: string, r: string) => fresh().canRead(w, u, r),
      canReadBatch: (w: string, u: string, r: string[]) => fresh().canReadBatch(w, u, r),
      canWrite: (w: string, u: string, r: string) => fresh().canWrite(w, u, r),
      canDownload: (w: string, u: string, r: string) => fresh().canDownload(w, u, r),
      canOwner: (w: string, u: string, r: string) => fresh().canOwner(w, u, r),
      canWriteBatchAtRef: async () => null,
      previewAccessAfterRelocation: (
        w: string, u: string, from: string, to: string, opts?: { sourceRemains?: boolean },
      ) => fresh().previewAccessAfterRelocation(w, u, from, to, opts),
    } as unknown as IAccessControl;
  };

  const call = async (base: string, tool: string, body: Record<string, unknown>) => {
    const res = await post(`${base}/api/agent/tools/${tool}`, body);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a tool body is free-form JSON, probed field by field
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };

  /**
   * `Sales/` grants the caller write and owner in its OWN access.md. `Work/`
   * grants both too, so `Work/Team` — which grants only write of its own —
   * holds owner by inheritance and loses it on the way out. `Legal/` grants
   * read to everyone and nothing else. The root grants read and nothing else,
   * so a folder that arrives there arrives with only what it brought.
   */
  async function seeded(): Promise<string> {
    const base = await start('write', liveRules(), MOVER);
    await fs.writeFile(KB('roles.yaml'), 'roles:\n  Admin:\n    - admin@x.io\n');
    await fs.writeFile(KB('access.md'), rules('read:\n  - everyone\n'));
    await fs.writeFile(KB('Sales/access.md'), rules(`write:\n  - Mover <${MOVER}>\nowner:\n  - Mover <${MOVER}>\n`));
    await fs.writeFile(KB('Sales/deal.md'), 'deal');
    await fs.writeFile(KB('Work/access.md'), rules(`write:\n  - Mover <${MOVER}>\nowner:\n  - Mover <${MOVER}>\n`));
    await fs.writeFile(KB('Work/Notes/note.md'), 'note');
    await fs.writeFile(KB('Work/Team/access.md'), rules(`write:\n  - Mover <${MOVER}>\n`));
    await fs.writeFile(KB('Work/Team/plan.md'), 'plan');
    await fs.writeFile(KB('Legal/access.md'), rules('read:\n  - everyone\n'));
    return base;
  }

  /** The caller's verbs where the thing really is now, through `file_stat`. */
  const verbsAt = async (base: string, path: string) =>
    (await call(base, 'file_stat', { path })).body.access;

  it('renaming a folder that names the caller owner previews no loss at all', async () => {
    const base = await seeded();
    const args = { src: KB('Sales'), dest: KB('Revenue') };

    const dry = await call(base, 'move_file', { ...args, dryRun: true });
    expect(dry.status).toBe(200);
    expect(dry.body).toMatchObject({ kind: 'folder', accessChanges: false, allowed: true, moved: false });
    expect(dry.body.access.after).toEqual(dry.body.access.before);
    expect(dry.body.access.after.owner).toBe(true);
    // Nothing moved and nothing was written to answer the question.
    expect(await fs.exists(args.dest)).toBe(false);
    expect(await fs.exists(KB('Sales/access.md'))).toBe(true);

    // `accessChanges: false`, so the move itself needs no confirmation.
    expect((await call(base, 'move_file', args)).body).toMatchObject({ moved: true });
    expect(await verbsAt(base, args.dest)).toEqual(dry.body.access.after);
  });

  it('moving a folder with no access.md of its own still previews the loss', async () => {
    const base = await seeded();
    const args = { src: KB('Work/Notes'), dest: KB('Legal/Notes') };

    const dry = await call(base, 'move_file', { ...args, dryRun: true });
    expect(dry.body).toMatchObject({ accessChanges: true, allowed: true });
    expect(dry.body.access.before.write).toBe(true);
    expect(dry.body.access.after.write).toBe(false);

    // A changed answer still asks before it moves.
    expect((await call(base, 'move_file', args)).body).toMatchObject({ confirmationRequired: true, moved: false });
    expect((await call(base, 'move_file', { ...args, confirm: true })).body).toMatchObject({ moved: true });
    expect(await verbsAt(base, args.dest)).toEqual(dry.body.access.after);
  });

  it('what the folder inherited is left behind; what its own access.md gives comes along', async () => {
    const base = await seeded();
    const args = { src: KB('Work/Team'), dest: KB('Legal/Team') };

    const dry = await call(base, 'move_file', { ...args, dryRun: true });
    // Write is the folder's own and travels; owner came from `Work/`.
    expect(dry.body.access.before).toMatchObject({ write: true, owner: true });
    expect(dry.body.access.after).toMatchObject({ write: true, owner: false });

    expect((await call(base, 'move_file', { ...args, confirm: true })).body).toMatchObject({ moved: true });
    expect(await verbsAt(base, args.dest)).toEqual(dry.body.access.after);
  });

  it('a nested access.md governs where it lands, not the folder above it', async () => {
    const base = await seeded();
    const args = { src: KB('Work/Team'), dest: KB('Legal/Team') };
    const withoutNested = (await call(base, 'move_file', { ...args, dryRun: true })).body.access.after;

    // `Sub/` shuts the caller out and moves too, but it governs `Legal/Team/Sub`.
    await fs.writeFile(KB('Work/Team/Sub/access.md'), rules(`read:\n  - deny Mover <${MOVER}>\n`));
    const dry = await call(base, 'move_file', { ...args, dryRun: true });
    expect(dry.body.access.after).toEqual(withoutNested);

    expect((await call(base, 'move_file', { ...args, confirm: true })).body).toMatchObject({ moved: true });
    expect(await verbsAt(base, args.dest)).toEqual(withoutNested);
    // The nested file did land and does govern where it landed: the caller
    // it shuts out cannot even stat the folder now.
    expect((await call(base, 'file_stat', { path: KB('Legal/Team/Sub') })).status).toBe(403);
  });

  it('moving a single file previews as it always did', async () => {
    const base = await seeded();
    const args = { src: KB('Sales/deal.md'), dest: KB('Legal/deal.md') };

    const dry = await call(base, 'move_file', { ...args, dryRun: true });
    expect(dry.body).toMatchObject({ kind: 'file', descendants: 1 });
    // Nothing travels with a file but its own bytes, so the answer is the
    // destination's own rules — what `file_stat` says there already.
    expect(dry.body.access.after).toEqual(await verbsAt(base, KB('Legal')));

    expect((await call(base, 'move_file', { ...args, confirm: true })).body).toMatchObject({ moved: true });
    expect(await verbsAt(base, args.dest)).toEqual(dry.body.access.after);
  });

  it('the preview answers the caller\'s own verbs and nothing more', async () => {
    const base = await seeded();
    const dry = await call(base, 'move_file', { src: KB('Sales'), dest: KB('Revenue'), dryRun: true });

    expect(Object.keys(dry.body.access).sort()).toEqual(['after', 'before']);
    for (const side of ['before', 'after'] as const) {
      expect(Object.keys(dry.body.access[side]).sort()).toEqual(['download', 'owner', 'read', 'write']);
    }
  });

  describe('copy_file previews the same way', () => {
    it('a folder copy counts the copied access.md at the destination', async () => {
      const base = await seeded();
      const args = { src: KB('Sales'), dest: KB('Sales-Copy') };

      const dry = await call(base, 'copy_file', { ...args, dryRun: true });
      expect(dry.status).toBe(200);
      expect(dry.body).toMatchObject({ kind: 'folder', accessChanges: false, copied: false, dryRun: true });
      expect(dry.body.access.after.owner).toBe(true);
      expect(dry.body.access.after).toEqual(dry.body.access.before);

      // `copy_file` copies ONE FILE, which the preview says rather than
      // promising a copy that cannot land — and the call itself refuses with
      // the same sentence, so preflight and execution never disagree.
      expect(dry.body.allowed).toBe(false);
      const run = await call(base, 'copy_file', args);
      expect(run.status).toBe(400);
      expect(run.body.error).toBe(dry.body.reason);
      expect(await fs.exists(args.dest)).toBe(false);
    });

    it('a file copy previews what the caller will have at the destination', async () => {
      const base = await seeded();
      const args = { src: KB('Sales/deal.md'), dest: KB('Legal/deal.md') };

      const dry = await call(base, 'copy_file', { ...args, dryRun: true });
      expect(dry.body).toMatchObject({ kind: 'file', descendants: 1, allowed: true, copied: false });
      expect(dry.body.access.before.write).toBe(true);
      expect(dry.body.access.after.write).toBe(false);
      expect(dry.body.accessChanges).toBe(true);
      expect(await fs.exists(args.dest)).toBe(false);

      expect((await call(base, 'copy_file', args)).body).toMatchObject({ copied: true });
      expect(await verbsAt(base, args.dest)).toEqual(dry.body.access.after);
      // A copy leaves the source exactly as it was.
      expect(await verbsAt(base, args.src)).toEqual(dry.body.access.before);
    });

    /**
     * `copy_file` will copy a lone `access.md`, and the moment it lands it
     * governs the folder it landed in. The preview counts it: the rules a
     * copy carries are the point of this ticket whether they travel inside a
     * folder or on their own.
     */
    it('a lone access.md previews the access it will give at the destination', async () => {
      const base = await seeded();
      // A folder with no rules of its own, so the destination's answer today
      // is the root's: read and nothing else. (`Legal/access.md` is taken, and
      // a copy onto a name that exists is refused long before access is asked.)
      await fs.writeFile(KB('Open/note.md'), 'note');
      const args = { src: KB('Sales/access.md'), dest: KB('Open/access.md') };

      const dry = await call(base, 'copy_file', { ...args, dryRun: true });
      expect(dry.body).toMatchObject({ kind: 'file', descendants: 1, allowed: true });
      expect(await verbsAt(base, KB('Open'))).toMatchObject({ write: false, owner: false });
      expect(dry.body.access.after).toMatchObject({ write: true, owner: true });
      expect(dry.body.accessChanges).toBe(false);

      expect((await call(base, 'copy_file', args)).body).toMatchObject({ copied: true });
      expect(await verbsAt(base, args.dest)).toEqual(dry.body.access.after);
    });

    it('a destination that is taken is named, and the dry run changes nothing', async () => {
      const base = await seeded();
      const args = { src: KB('Sales/deal.md'), dest: KB('Work/Notes/note.md') };

      const dry = await call(base, 'copy_file', { ...args, dryRun: true });
      expect(dry.body.allowed).toBe(false);
      expect(dry.body.reason).toContain('already exists');
      expect(String(await fs.readFile(KB('Work/Notes/note.md'), { encoding: 'utf-8' }))).toContain('note');
    });
  });
});
