import type { Server as HttpServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import AdmZip from 'adm-zip';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalFilesystem } from '@mastra/core/workspace';
import { testKbContext } from '../../../__tests__/kb-context.js';
import { ToolRegistry } from '../../tool-registry/tool-registry.js';
import { createToolHandlerFactory } from '../../tool-helpers/tool-handler.js';
import type { ToolContext } from '../../tool-helpers/tool.contract.js';
import type { ToolAuth } from '../../tool-auth/tool-auth.middleware.js';
import { registerWorkspaceTools } from '../workspace.tools.js';
import { RoutineWritePolicyService } from '../routine-write-policy.js';
import { WorkflowHooks } from '../../workflow/workflow-hooks.js';
import { ToolDescriptionNotes } from '../agent-access.gate.js';
import { SpillStore } from '../spill-store.js';
import { DocExtractService } from '../file-readers/doc-extract.service.js';
import type { IAccessControl } from '../../access/access-control.interface.js';
import { normalizeWorkspacePath } from '../../kb-fs/repo-path.js';
import {
  AgentUploadStore,
  assertUploadsRootOutsideWorkspaces,
  UPLOAD_TOKEN_REFUSAL,
} from '../agent-upload.store.js';
import { createAgentUploadRoutes, isAgentUploadRawBodyPath } from '../agent-upload.routes.js';
import { READ_ONLY_CODE, type IWriteAccess } from '../../write-access/write-access.js';
import { MAX_UPLOAD_BYTES } from '../upload-limits.js';

/**
 * The upload route an agent lands files by, end to end: a token, bytes sent to
 * the address with no session of any kind, and an apply that commits them on a
 * branch.
 *
 * Every Scenario in `Agent uploads files: Specification` has a test here. The
 * filesystem is a REAL `LocalFilesystem` over a temp dir, with a `writeFiles`
 * stand-in for the locking batch (as `workspace.tools.test.ts` uses): the
 * tests assert what the TOOL controls — one batch for the whole upload, a
 * per-path outcome, and the exact bytes on disk. That the batch is atomic is
 * asserted where it lives, in `locking-filesystem.test.ts`.
 */

const KB_DIR = 'knowledge-base';
/** A draft branch — not one `testKbContext` protects. */
const DRAFT = 'draft';
/** A branch the test context protects, where the lock gate's write rules apply. */
const PROTECTED = 'target-company-state';
const PUBLIC_BASE = 'https://kb.example.com';

const allowAll = {
  canRead: async () => true,
  canReadBatch: async (_w: string, _u: string, paths: string[]) => new Map(paths.map((p) => [p, true])),
  canWrite: async () => true,
  canDownload: async () => true,
  canOwner: async () => true,
  canWriteBatchAtRef: async () => null,
  eligibleWritersAtRef: async () => ({ roles: ['Admin'], users: [] }),
} as unknown as IAccessControl;

/**
 * Access control that, at HEAD on a protected branch, denies `write` for an
 * explicit set of repo-relative paths — which is the only verdict the write
 * tools' preflight consults (`writeBlocked`). Everything else is allowed, so a
 * test says exactly which path it is about.
 */
function denyWritesAtHead(denied: (rel: string) => boolean): IAccessControl {
  return {
    ...allowAll,
    canRead: async () => true,
    canWriteBatchAtRef: async (_w: string, _ref: string, _u: string, rels: string[]) =>
      new Map(rels.map((rel) => [rel, !denied(rel)])),
    eligibleWritersAtRef: async () => ({ roles: ['Editor'], users: [{ name: 'Ada', email: 'ada@x' }] }),
  } as unknown as IAccessControl;
}

/** Every server a test started — a second one stands for a second caller. */
let servers: HttpServer[] = [];
let tempDir = '';
let uploadsDir = '';
let docCacheDir = '';
let fs: LocalFilesystem;
let uploads: AgentUploadStore;
let toolRegistry: ToolRegistry;
/** One entry per `writeFiles` batch the tools landed: the paths it carried. */
let batches: string[][] = [];
/** One entry per folder turn a tool took: the folder it named. */
let folderTurns: string[] = [];
/** How many folder turns are held right now — a batch reads it to prove it ran inside one. */
let turnsHeld = 0;
/** The depth `turnsHeld` stood at while each `writeFiles` batch landed. */
let batchTurnDepth: number[] = [];
/**
 * Held by a test that wants an apply to WAIT, standing in for the folder turn
 * a concurrent `delete_folder` would be holding over the same subtree.
 */
let folderTurnGate: Promise<void> | undefined;
/**
 * Resolved the moment a tool ASKS for a folder turn — before any wait on
 * `folderTurnGate`. A test awaits this instead of sleeping: when it resolves,
 * the apply is parked on the gate with certainty, not with probability.
 */
let folderTurnAsked: Promise<void>;
let announceFolderTurnAsked: () => void;

interface StartOptions {
  access?: IAccessControl;
  userId?: string;
  userEmail?: string;
  ttlMs?: number;
  maxBytes?: number;
  /** Start the periodic sweep at this interval BEFORE any token is issued. */
  sweepEveryMs?: number;
  /** The store's listing seam, for a test that needs to hold a sweep open. */
  listRoot?: (root: string) => Promise<string[]>;
  /**
   * Mount against a store that is already running, so a second server can
   * stand for a second caller — a different connection key, the same server's
   * store — without the first one's state being thrown away.
   */
  store?: AgentUploadStore;
  /**
   * The deployment’s write verdict, as a host fills it. Default (absent) is
   * core’s own: always writable.
   */
  writeAccess?: IWriteAccess;
}

async function start(options: StartOptions = {}): Promise<string> {
  const { access = allowAll, userId = 'u', userEmail = 'e@x' } = options;
  if (options.store === undefined) {
    tempDir = await mkdtemp(join(tmpdir(), 'ws-upload-'));
    uploadsDir = await mkdtemp(join(tmpdir(), 'agent-uploads-'));
    docCacheDir = await mkdtemp(join(tmpdir(), 'ws-upload-doc-'));
    batches = [];
    folderTurns = [];
    batchTurnDepth = [];
    turnsHeld = 0;
    folderTurnGate = undefined;
    folderTurnAsked = new Promise<void>((resolve) => (announceFolderTurnAsked = resolve));
  }
  fs = new LocalFilesystem({ basePath: tempDir, contained: true });
  // The harness speaks the paths the TOOLS speak: a fixture written here as
  // `Skills/x.md` lands where a tool asking for `Skills/x.md` will read it.
  for (const method of ['readFile', 'writeFile', 'appendFile', 'deleteFile', 'mkdir', 'stat'] as const) {
    const inner = (fs as unknown as Record<string, (...a: unknown[]) => unknown>)[method].bind(fs);
    (fs as unknown as Record<string, unknown>)[method] = (path: string, ...rest: unknown[]) =>
      inner(normalizeWorkspacePath(path, KB_DIR), ...rest);
  }
  const plainWriteFile = fs.writeFile.bind(fs);
  // Stands in for `LockingFilesystem.writeFiles`: honours the caller's
  // under-lock `check` (run with the paths "locked", just before any byte
  // lands) and writes only what the check keeps. Content arrives as a Buffer
  // from an apply, and is written through untouched — which is the property
  // byte-for-byte landing rests on.
  (fs as unknown as Record<string, unknown>).writeFiles = async (
    writes: { path: string; content: string | Buffer }[],
    _summary: string,
    deletes: string[] = [],
    check?: (
      pending: readonly { path: string; content: string | Buffer }[],
    ) => Promise<{ path: string; content: string | Buffer }[]>,
  ) => {
    const landing = check ? await check(writes) : writes;
    batches.push(landing.map((w) => w.path));
    batchTurnDepth.push(turnsHeld);
    for (const w of landing) await plainWriteFile(w.path, w.content as never);
    for (const p of deletes) await fs.deleteFile(p);
  };

  uploads =
    options.store ??
    new AgentUploadStore({
      root: uploadsDir,
      publicBaseUrl: PUBLIC_BASE,
      tokenPrefix: 'bevel-up_',
      ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}),
      ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
      ...(options.listRoot !== undefined ? { listRoot: options.listRoot } : {}),
    });
  if (options.sweepEveryMs !== undefined) uploads.startSweeping(options.sweepEveryMs);

  const registry = new ToolRegistry();
  toolRegistry = registry;
  const resolve = async (auth: ToolAuth, signal: AbortSignal, sessionId?: string): Promise<ToolContext> => ({
    user: { id: userId, email: userEmail, name: 'N' },
    scope: auth.scope,
    source: auth.source,
    sessionId,
    abortSignal: signal,
    workspaceService: {
      getOrCreateForBranch: async (branch: string) => ({
        id: encodeURIComponent(branch),
        name: branch,
        absolutePath: tempDir,
        createdAt: '',
        kbDirName: KB_DIR,
      }),
      getWorkspacePath: async () => tempDir,
      hasBootstrappedWorkspace: async () => false,
      // Stands in for `WorkspaceService.withFolderTurn`: records the folder
      // whose turn was taken, and waits on `folderTurnGate` on the way in so a
      // test can hold the subtree the way a concurrent `delete_folder` holds
      // it. The real one serialises overlapping subtrees; what a tool test can
      // check is that the tool TAKES the turn, over the right folder, and that
      // it lands nothing until the turn is its own.
      withFolderTurn: async <T>(_id: string, dir: string, op: () => Promise<T>): Promise<T> => {
        folderTurns.push(dir);
        announceFolderTurnAsked();
        if (folderTurnGate !== undefined) await folderTurnGate;
        turnsHeld++;
        try {
          return await op();
        } finally {
          turnsHeld--;
        }
      },
    } as never,
    workflowService: {} as never,
    events: {} as never,
    getFilesystem: async () => fs,
  });
  const toolHandler =
    options.writeAccess !== undefined
      ? createToolHandlerFactory(resolve, options.writeAccess)
      : createToolHandlerFactory(resolve);
  const fakeAuth = (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.toolAuth = { source: 'external', userId, scope: 'write' };
    next();
  };
  const app = express();
  app.use((req, res, next) => (isAgentUploadRawBodyPath(req.path) ? next() : express.json()(req, res, next)));
  const router = express.Router();
  registerWorkspaceTools(
    registry,
    router,
    fakeAuth,
    toolHandler,
    new SpillStore(join(tmpdir(), 'bevel-test-spills')),
    new DocExtractService(docCacheDir),
    access,
    testKbContext({ kbDirName: KB_DIR }),
    { recoveryBotEmail: 'recovery-bot@bevel.local', hooks: new WorkflowHooks(), notes: new ToolDescriptionNotes() },
    new RoutineWritePolicyService(),
    {} as never,
    undefined,
    undefined,
    uploads,
  );
  router.use(createAgentUploadRoutes({ uploads }));
  app.use('/api', router);
  const httpServer = await new Promise<HttpServer>((r) => {
    const s = app.listen(0, () => r(s));
  });
  servers.push(httpServer);
  return `http://127.0.0.1:${(httpServer.address() as { port: number }).port}`;
}

afterEach(async () => {
  uploads?.stopSweeping();
  for (const server of servers) await new Promise<void>((r) => server.close(() => r()));
  servers = [];
  for (const dir of [tempDir, uploadsDir, docCacheDir]) {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
  tempDir = '';
  uploadsDir = '';
  docCacheDir = '';
});

const call = (base: string, tool: string, body: unknown = {}) =>
  fetch(`${base}/api/agent/tools/${tool}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer x' },
    body: JSON.stringify(body),
  });

const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;

interface Issued {
  uploadUrl: string;
  token: string;
  expiresAt: string;
  expiresInSeconds: number;
  maxBytes: number;
}

const request = async (base: string): Promise<Issued> =>
  json<Issued>(await call(base, 'request_file_upload', {}));

/** POST bytes to the token's address, exactly as `curl --data-binary` would. */
const send = (
  base: string,
  token: string,
  filename: string,
  data: Buffer,
  contentType = 'application/octet-stream',
) =>
  fetch(`${base}/api/agent/uploads/${encodeURIComponent(token)}?filename=${encodeURIComponent(filename)}`, {
    method: 'POST',
    headers: { 'content-type': contentType },
    body: data,
  });

interface ApplyAnswer {
  destination: string;
  count: number;
  total: number;
  files: { path: string; outcome: string; error?: string; message?: string }[];
  truncated?: boolean;
  error?: string;
  proposal?: { targetBranch: string; draftBranch: string; steps: { tool: string }[] };
  canPropose?: boolean;
}

const apply = async (base: string, body: Record<string, unknown>): Promise<ApplyAnswer> =>
  json<ApplyAnswer>(await call(base, 'apply_file_upload', body));

const sha = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

function zipOf(entries: Record<string, Buffer | string>): Buffer {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(entries)) {
    zip.addFile(name, Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'));
  }
  return zip.toBuffer();
}

/**
 * A zip whose members keep the names given here VERBATIM. `AdmZip.addFile`
 * sanitizes what it is handed — `../outside.md` goes in as `outside.md` — so a
 * test about an entry name that climbs out has to set the name afterwards, as
 * the tools that write such archives do.
 */
function zipWithRawNames(entries: Record<string, Buffer | string>): Buffer {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(entries)) {
    const placeholder = `__raw_${zip.getEntries().length}`;
    zip.addFile(placeholder, Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'));
    const added = zip.getEntries().find((e) => e.entryName === placeholder);
    if (!added) throw new Error(`could not add "${name}" to the test archive`);
    added.entryName = name;
  }
  return zip.toBuffer();
}

/**
 * A one-entry zip whose headers CLAIM `declaredSize` uncompressed bytes while
 * holding only `content`.
 *
 * What a zip bomb looks like to a reader before it decompresses anything, and
 * the only way to write one in a test without allocating the bytes it claims:
 * the uncompressed-size field is patched in both the local file header and the
 * central directory, which is where every reader takes an entry's size from.
 * An apply that believed the field only after inflating would have to hold the
 * expansion in memory to find out.
 */
function zipWithDeclaredSize(name: string, content: string, declaredSize: number): Buffer {
  const buffer = zipOf({ [name]: content });
  // The uncompressed-size field: 22 bytes into a local file header, 24 into a
  // central-directory one (see APPNOTE 4.3.7 and 4.3.12).
  for (const [signature, offset] of [
    [0x04034b50, 22],
    [0x02014b50, 24],
  ] as const) {
    for (let at = 0; at + 4 <= buffer.length; at++) {
      if (buffer.readUInt32LE(at) === signature) buffer.writeUInt32LE(declaredSize, at + offset);
    }
  }
  return buffer;
}

/** A real PNG: the 1×1 transparent one, so the bytes are a genuine image. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

const outcomeAt = (answer: ApplyAnswer, path: string) => answer.files.find((f) => f.path === path);

describe('request_file_upload', () => {
  it('answers a one-time address, a token, the expiry and the size limit', async () => {
    const base = await start();
    const issued = await request(base);
    expect(issued.uploadUrl).toBe(`${PUBLIC_BASE}/api/agent/uploads/${encodeURIComponent(issued.token)}`);
    expect(issued.token.startsWith('bevel-up_')).toBe(true);
    // 32 random bytes, base64url — nothing derived from the user or the clock.
    expect(issued.token.length).toBeGreaterThan(40);
    expect(Date.parse(issued.expiresAt)).toBeGreaterThan(Date.now());
    expect(issued.expiresInSeconds).toBeGreaterThan(0);
    expect(issued.maxBytes).toBe(MAX_UPLOAD_BYTES);
  });

  it('mints a different token every time', async () => {
    const base = await start();
    const [a, b] = [await request(base), await request(base)];
    expect(a.token).not.toBe(b.token);
  });

  it('is on both tool surfaces, with apply_file_upload', async () => {
    await start();
    const names = (await toolRegistry.listExternal()).map((t) => t.name);
    expect(names).toContain('request_file_upload');
    expect(names).toContain('apply_file_upload');
    const internal = (await toolRegistry.listInternal()).map((t) => t.name);
    expect(internal).toContain('request_file_upload');
    expect(internal).toContain('apply_file_upload');
  });
});

describe('the upload route', () => {
  it('stores the bytes outside every workspace and names what it received', async () => {
    const base = await start();
    const { token } = await request(base);
    const res = await send(base, token, 'notes.md', Buffer.from('hello'));
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ filename: 'notes.md', bytes: 5, kind: 'file' });
    // BESIDE the workspaces root, never inside one: the bytes are content the
    // server has accepted and not yet judged.
    expect(uploadsDir.startsWith(tempDir)).toBe(false);
    const stored = await readdir(uploadsDir);
    expect(stored).toHaveLength(1);
    expect(await readFile(join(uploadsDir, stored[0]), 'utf8')).toBe('hello');
  });

  it('counts a zip\'s entries in the answer', async () => {
    const base = await start();
    const { token } = await request(base);
    const zip = zipOf({ 'SKILL.md': '# Skill\n', 'docs/a.md': 'a', 'logo.png': PNG });
    const res = await send(base, token, 'skill.zip', zip);
    expect(await json(res)).toEqual({ filename: 'skill.zip', bytes: zip.byteLength, kind: 'zip', entries: 3 });
  });

  it('needs no session of any kind — the token is the whole credential', async () => {
    const base = await start();
    const { token } = await request(base);
    // No Authorization header at all, which is what an agent's `curl` sends.
    const res = await fetch(`${base}/api/agent/uploads/${token}?filename=x.md`, {
      method: 'POST',
      body: Buffer.from('x'),
    });
    expect(res.status).toBe(200);
  });

  it('keeps the exact bytes even when the sender claims a JSON content-type', async () => {
    const base = await start();
    const { token } = await request(base);
    // `curl --data-binary @f -H 'content-type: application/json'` — the global
    // JSON parser must not have drained the stream (isAgentUploadRawBodyPath).
    const body = Buffer.from('{"not":"json at all\\u0000"}\u0000\u0001', 'utf8');
    const res = await send(base, token, 'raw.bin', body, 'application/json');
    expect(await json(res)).toMatchObject({ bytes: body.byteLength });
  });

  it('refuses an upload over the limit, naming the limit', async () => {
    const base = await start({ maxBytes: 1024 });
    const { token, maxBytes } = await request(base);
    expect(maxBytes).toBe(1024);
    const res = await send(base, token, 'big.bin', Buffer.alloc(2048, 7));
    expect(res.status).toBe(413);
    expect((await json<{ error: string }>(res)).error).toContain('1024 byte upload limit');
    expect(await readdir(uploadsDir)).toEqual([]);
  });

  it('refuses a second upload against the same token', async () => {
    const base = await start();
    const { token } = await request(base);
    expect((await send(base, token, 'a.md', Buffer.from('a'))).status).toBe(200);
    const second = await send(base, token, 'b.md', Buffer.from('b'));
    expect(second.status).toBe(404);
    expect((await json<{ error: string }>(second)).error).toBe(UPLOAD_TOKEN_REFUSAL);
  });

  it('refuses an unknown token with one message that says nothing about it', async () => {
    const base = await start();
    const res = await send(base, 'bevel-up_nope', 'a.md', Buffer.from('a'));
    expect(res.status).toBe(404);
    expect((await json<{ error: string }>(res)).error).toBe(UPLOAD_TOKEN_REFUSAL);
  });

  it('tells an unknown token nothing about its OTHER mistakes either', async () => {
    const base = await start();
    // No file name at all, and a name no filesystem would keep — both
    // ordinarily a 400 that says which. Against a token that does not exist
    // they get the one refusal instead: "that is not a usable file name" is an
    // answer only somebody entitled to send a file should be able to collect.
    for (const url of [
      `${base}/api/agent/uploads/bevel-up_nope`,
      `${base}/api/agent/uploads/bevel-up_nope?filename=${encodeURIComponent('../escape.md')}`,
    ]) {
      const res = await fetch(url, { method: 'POST', body: Buffer.from('x') });
      expect(res.status).toBe(404);
      expect((await json<{ error: string }>(res)).error).toBe(UPLOAD_TOKEN_REFUSAL);
    }
  });

  it('does not read a parameter that merely ENDS in "filename" as the name', async () => {
    const base = await start();
    const { token } = await request(base);
    // `xfilename` is a parameter of its own, and `filename` is its suffix. The
    // name is asked for instead of taken from it.
    const res = await fetch(`${base}/api/agent/uploads/${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'content-disposition': 'inline; xfilename=wrong.md' },
      body: Buffer.from('x'),
    });
    expect(res.status).toBe(400);
    expect((await json<{ error: string }>(res)).error).toContain('filename');
    expect(await readdir(uploadsDir)).toEqual([]);
  });

  it('asks for a file name when none was given', async () => {
    const base = await start();
    const { token } = await request(base);
    const res = await fetch(`${base}/api/agent/uploads/${token}`, { method: 'POST', body: Buffer.from('x') });
    expect(res.status).toBe(400);
    expect((await json<{ error: string }>(res)).error).toContain('filename');
  });

  it('refuses a file name that is a path', async () => {
    const base = await start();
    const { token } = await request(base);
    const res = await send(base, token, '../escape.md', Buffer.from('x'));
    expect(res.status).toBe(400);
  });

  it('refuses the second of two uploads sent against one token at the same time', async () => {
    const base = await start();
    const { token } = await request(base);
    // Both in flight before either has finished: the token is reserved before
    // the first `await` of the attach, so exactly one of them is accepted and
    // the other meets the one refusal. Without the reservation both stored
    // their bytes and the apply landed whichever finished last.
    const [first, second] = await Promise.all([
      send(base, token, 'first.md', Buffer.from('first')),
      send(base, token, 'second.md', Buffer.from('second')),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 404]);
    expect(await readdir(uploadsDir)).toHaveLength(1);
    // And the file the accepted answer named is the file the apply lands.
    const accepted = first.status === 200 ? first : second;
    const { filename } = await json<{ filename: string }>(accepted);
    const answer = await apply(base, { branch: DRAFT, token, destination: `${KB_DIR}/Race` });
    expect(answer.files).toEqual([{ path: `${KB_DIR}/Race/${filename}`, outcome: 'created' }]);
    expect(await readFile(join(tempDir, KB_DIR, 'Race', filename), 'utf8')).toBe(filename.replace('.md', ''));
  });

  it('refuses an unknown token before it has read a single byte of the body', async () => {
    const base = await start({ maxBytes: 64 });
    // Over the limit AND against a token that does not exist. The 404 proves
    // the token was judged first: had the body been buffered, the size check
    // inside the read would have answered 413 instead. That ordering is what
    // keeps an invented token from making the process hold the deployment's
    // whole upload limit in memory.
    const res = await fetch(`${base}/api/agent/uploads/bevel-up_invented?filename=big.md`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: Buffer.alloc(200, 7),
    });
    expect(res.status).toBe(404);
    expect((await json<{ error: string }>(res)).error).toBe(UPLOAD_TOKEN_REFUSAL);
    expect(await readdir(uploadsDir)).toEqual([]);
  });

  it('keeps a quoted content-disposition name that holds a semicolon', async () => {
    const base = await start();
    const { token } = await request(base);
    const res = await fetch(`${base}/api/agent/uploads/${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'content-disposition': 'attachment; filename="report;final.md"' },
      body: Buffer.from('r'),
    });
    expect(await json<{ filename: string }>(res)).toMatchObject({ filename: 'report;final.md' });
  });

  it('reads the extended content-disposition name, percent-decoded', async () => {
    const base = await start();
    const { token } = await request(base);
    const res = await fetch(`${base}/api/agent/uploads/${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'content-disposition': "attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.md" },
      body: Buffer.from('r'),
    });
    expect(await json<{ filename: string }>(res)).toMatchObject({ filename: 'résumé.md' });
  });

  it('reads a plain content-disposition name as the name itself, percent signs and all', async () => {
    const base = await start();
    const { token } = await request(base);
    const res = await fetch(`${base}/api/agent/uploads/${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'content-disposition': 'attachment; filename=50%20off.md' },
      body: Buffer.from('r'),
    });
    expect(await json<{ filename: string }>(res)).toMatchObject({ filename: '50%20off.md' });
  });

  it('answers an unexpected failure without quoting the filesystem back', async () => {
    const base = await start();
    const { token } = await request(base);
    // The store's root replaced by a FILE, so the attach's `mkdir` fails with
    // an ENOTDIR whose message carries the absolute path of the staging root —
    // a place the caller is told nothing else about.
    await rm(uploadsDir, { recursive: true, force: true });
    await writeFile(uploadsDir, 'not a directory');
    const res = await send(base, token, 'a.md', Buffer.from('a'));
    expect(res.status).toBe(500);
    expect(await json<{ error: string }>(res)).toEqual({ error: 'Upload failed' });
    // Removed here, because `afterEach` deletes a directory, not a file.
    await rm(uploadsDir, { force: true });
    uploadsDir = '';
  });

  it('refuses a .zip whose bytes are not an archive, while the caller still holds the file', async () => {
    const base = await start();
    const { token } = await request(base);
    const res = await send(base, token, 'broken.zip', Buffer.from('not a zip at all'));
    expect(res.status).toBe(422);
    expect((await json<{ error: string }>(res)).error).toContain('not a readable .zip');
  });
});

describe('apply_file_upload', () => {
  it('lands a zip\'s entries in ONE commit, each created, keeping the folder structure', async () => {
    const base = await start();
    const { token } = await request(base);
    await send(base, token, 'skill.zip', zipOf({
      'SKILL.md': '# My skill\n',
      'references/guide.md': 'guide\n',
      'assets/logo.png': PNG,
    }));
    const answer = await apply(base, { branch: DRAFT, token, destination: `${KB_DIR}/Skills/my-skill` });
    expect(answer.destination).toBe(`${KB_DIR}/Skills/my-skill`);
    expect(answer.total).toBe(3);
    expect(answer.count).toBe(3);
    expect(answer.files.map((f) => f.outcome)).toEqual(['created', 'created', 'created']);
    expect(answer.files.map((f) => f.path).sort()).toEqual([
      `${KB_DIR}/Skills/my-skill/SKILL.md`,
      `${KB_DIR}/Skills/my-skill/assets/logo.png`,
      `${KB_DIR}/Skills/my-skill/references/guide.md`,
    ]);
    // One batch, so one commit for the whole upload.
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(3);
    expect(await readFile(join(tempDir, KB_DIR, 'Skills/my-skill/references/guide.md'), 'utf8')).toBe('guide\n');
  });

  it('lands a single file under the name it was sent with', async () => {
    const base = await start();
    const { token } = await request(base);
    await send(base, token, 'page.html', Buffer.from('<p>hi</p>'));
    const answer = await apply(base, { branch: DRAFT, token, destination: `${KB_DIR}/Pages` });
    expect(answer.files).toEqual([{ path: `${KB_DIR}/Pages/page.html`, outcome: 'created' }]);
    expect(await readFile(join(tempDir, KB_DIR, 'Pages/page.html'), 'utf8')).toBe('<p>hi</p>');
  });

  // Scenario: the zip holds SKILL.md and SKILL.md already exists, `mode` left out.
  it('refuses an existing path with `exists` under the default mode, and lands the others', async () => {
    const base = await start();
    await mkdir(join(tempDir, KB_DIR, 'Skills/my-skill'), { recursive: true });
    await writeFile(join(tempDir, KB_DIR, 'Skills/my-skill/SKILL.md'), 'mine\n');
    const { token } = await request(base);
    await send(base, token, 'skill.zip', zipOf({ 'SKILL.md': '# new\n', 'extra.md': 'extra\n' }));
    const answer = await apply(base, { branch: DRAFT, token, destination: `${KB_DIR}/Skills/my-skill` });
    expect(answer.count).toBe(1);
    expect(answer.total).toBe(2);
    expect(outcomeAt(answer, `${KB_DIR}/Skills/my-skill/SKILL.md`)).toMatchObject({
      outcome: 'refused',
      error: 'exists',
    });
    expect(outcomeAt(answer, `${KB_DIR}/Skills/my-skill/extra.md`)).toMatchObject({ outcome: 'created' });
    // The refused path is left exactly as it was.
    expect(await readFile(join(tempDir, KB_DIR, 'Skills/my-skill/SKILL.md'), 'utf8')).toBe('mine\n');
    expect(await readFile(join(tempDir, KB_DIR, 'Skills/my-skill/extra.md'), 'utf8')).toBe('extra\n');
  });

  it('replaces an existing path with `mode: overwrite`', async () => {
    const base = await start();
    await mkdir(join(tempDir, KB_DIR, 'Skills/my-skill'), { recursive: true });
    await writeFile(join(tempDir, KB_DIR, 'Skills/my-skill/SKILL.md'), 'mine\n');
    const { token } = await request(base);
    await send(base, token, 'skill.zip', zipOf({ 'SKILL.md': '# new\n' }));
    const answer = await apply(base, {
      branch: DRAFT,
      token,
      destination: `${KB_DIR}/Skills/my-skill`,
      mode: 'overwrite',
    });
    expect(answer.files).toEqual([{ path: `${KB_DIR}/Skills/my-skill/SKILL.md`, outcome: 'replaced' }]);
    expect(await readFile(join(tempDir, KB_DIR, 'Skills/my-skill/SKILL.md'), 'utf8')).toBe('# new\n');
  });

  it('`mode: update` refuses a path that does not exist and updates one that does', async () => {
    const base = await start();
    await mkdir(join(tempDir, KB_DIR, 'Pages'), { recursive: true });
    await writeFile(join(tempDir, KB_DIR, 'Pages/there.md'), 'old\n');
    const { token } = await request(base);
    await send(base, token, 'pair.zip', zipOf({ 'there.md': 'new\n', 'missing.md': 'nope\n' }));
    const answer = await apply(base, { branch: DRAFT, token, destination: `${KB_DIR}/Pages`, mode: 'update' });
    expect(outcomeAt(answer, `${KB_DIR}/Pages/there.md`)).toMatchObject({ outcome: 'updated' });
    expect(outcomeAt(answer, `${KB_DIR}/Pages/missing.md`)).toMatchObject({
      outcome: 'refused',
      error: 'missing',
    });
    expect(await readFile(join(tempDir, KB_DIR, 'Pages/there.md'), 'utf8')).toBe('new\n');
  });

  it('refuses a mode that is not one of the three', async () => {
    const base = await start();
    const { token } = await request(base);
    await send(base, token, 'a.md', Buffer.from('a'));
    const res = await call(base, 'apply_file_upload', {
      branch: DRAFT,
      token,
      destination: `${KB_DIR}/Pages`,
      mode: 'replace',
    });
    expect(res.status).toBe(400);
  });

  // Scenario: a 40 KB page of unicode escapes, backslashes and quotes — the
  // content a JSON tool parameter cannot carry — lands with its own checksum.
  it('lands an escape-heavy text file byte for byte', async () => {
    const base = await start();
    const line = 'const re = /\\u00e9\\\\[a-z]+"quoted"\\n\\t/g; // "\\u2028" \\\\ \'é中文 \n';
    const page = Buffer.from(line.repeat(Math.ceil(40 * 1024 / line.length)), 'utf8');
    expect(page.byteLength).toBeGreaterThan(40 * 1024);
    const before = sha(page);
    const { token } = await request(base);
    await send(base, token, 'page.html', page);
    await apply(base, { branch: DRAFT, token, destination: `${KB_DIR}/Pages` });
    const landed = await readFile(join(tempDir, KB_DIR, 'Pages/page.html'));
    expect(sha(landed)).toBe(before);
  });

  it('lands a PNG byte for byte', async () => {
    const base = await start();
    const before = sha(PNG);
    const { token } = await request(base);
    await send(base, token, 'logo.png', PNG);
    await apply(base, { branch: DRAFT, token, destination: `${KB_DIR}/Pages/assets` });
    const landed = await readFile(join(tempDir, KB_DIR, 'Pages/assets/logo.png'));
    expect(sha(landed)).toBe(before);
    expect(landed.equals(PNG)).toBe(true);
  });

  it('lands a PNG and a text file out of one zip, both with their own checksums', async () => {
    const base = await start();
    const markdown = Buffer.from('Backslashes \\\\ and "quotes" and \\u00e9 as text.\n', 'utf8');
    const { token } = await request(base);
    await send(base, token, 'mixed.zip', zipOf({ 'logo.png': PNG, 'notes.md': markdown }));
    await apply(base, { branch: DRAFT, token, destination: `${KB_DIR}/Mixed` });
    expect(sha(await readFile(join(tempDir, KB_DIR, 'Mixed/logo.png')))).toBe(sha(PNG));
    expect(sha(await readFile(join(tempDir, KB_DIR, 'Mixed/notes.md')))).toBe(sha(markdown));
  });

  // Scenario: the destination is on a protected branch the caller may not
  // write directly.
  it('lands nothing on a protected branch it may not write, and names the change-request route', async () => {
    const base = await start({ access: denyWritesAtHead(() => true) });
    const { token } = await request(base);
    await send(base, token, 'skill.zip', zipOf({ 'a.md': 'a', 'b.md': 'b' }));
    const res = await call(base, 'apply_file_upload', {
      branch: PROTECTED,
      token,
      destination: `${KB_DIR}/Skills/my-skill`,
    });
    expect(res.status).toBe(403);
    const body = await json<ApplyAnswer & { kind?: string }>(res);
    expect(body.kind).toBe('write-denied');
    expect(body.canPropose).toBe(true);
    expect(body.proposal?.steps.map((s) => s.tool)).toEqual([
      'create_branch',
      'apply_file_upload',
      'open_change_request',
    ]);
    expect(batches).toEqual([]);
    // The token survives a refusal that landed nothing, so the bytes need not
    // be sent again to try a draft branch instead.
    const retry = await apply(base, { branch: DRAFT, token, destination: `${KB_DIR}/Skills/my-skill` });
    expect(retry.count).toBe(2);
  });

  // Scenario: one entry targets a folder the caller may not write.
  it('refuses the one entry whose own path is denied, and lands the others', async () => {
    const base = await start({ access: denyWritesAtHead((rel) => rel.startsWith('Locked/')) });
    const { token } = await request(base);
    await send(base, token, 'drop.zip', zipOf({ 'open.md': 'open', 'Locked/secret.md': 'secret' }));
    const answer = await apply(base, { branch: PROTECTED, token, destination: KB_DIR });
    expect(outcomeAt(answer, `${KB_DIR}/Locked/secret.md`)).toMatchObject({
      outcome: 'refused',
      error: 'write-denied',
    });
    expect(outcomeAt(answer, `${KB_DIR}/Locked/secret.md`)?.message).toContain('Eligible:');
    expect(outcomeAt(answer, `${KB_DIR}/open.md`)).toMatchObject({ outcome: 'created' });
    expect(answer.count).toBe(1);
  });

  // Scenario: an entry named `access.md`, or one that would create a platform
  // folder.
  it('refuses a platform file with the platform-file sentence, and lands the others', async () => {
    const base = await start();
    const { token } = await request(base);
    await send(base, token, 'drop.zip', zipOf({
      'access.md': '---\nread: everyone\n---\n',
      'roles.yaml': 'Admin:\n  - e@x\n',
      'ok.md': 'ok',
    }));
    const answer = await apply(base, { branch: DRAFT, token, destination: KB_DIR });
    expect(outcomeAt(answer, `${KB_DIR}/access.md`)).toMatchObject({
      outcome: 'refused',
      error: 'platform_file',
      message: 'access.md is a platform file and is never landed by an upload — change it with edit_file or write_file, where the change is checked.',
    });
    expect(outcomeAt(answer, `${KB_DIR}/roles.yaml`)).toMatchObject({ outcome: 'refused', error: 'platform_file' });
    expect(outcomeAt(answer, `${KB_DIR}/ok.md`)).toMatchObject({ outcome: 'created' });
    expect(await readdir(join(tempDir, KB_DIR))).toEqual(['ok.md']);
  });

  it('refuses an entry that would create the checkout folder\'s own name at the root', async () => {
    const base = await start();
    const { token } = await request(base);
    await send(base, token, 'drop.zip', zipOf({ [`${KB_DIR}/inner.md`]: 'inner', 'ok.md': 'ok' }));
    const answer = await apply(base, { branch: DRAFT, token, destination: KB_DIR });
    expect(outcomeAt(answer, `${KB_DIR}/${KB_DIR}/inner.md`)).toMatchObject({
      outcome: 'refused',
      error: 'reserved-root-name',
    });
    expect(outcomeAt(answer, `${KB_DIR}/ok.md`)).toMatchObject({ outcome: 'created' });
  });

  // Scenario: a zip entry is `../outside.md` or a symbolic link.
  it('refuses an entry that would land outside the destination, and lands the others', async () => {
    const base = await start();
    const { token } = await request(base);
    await send(base, token, 'drop.zip', zipWithRawNames({
      '../outside.md': 'escaped',
      '/rooted.md': 'rooted',
      'inside.md': 'inside',
    }));
    const answer = await apply(base, { branch: DRAFT, token, destination: `${KB_DIR}/Drop` });
    expect(answer.total).toBe(3);
    expect(answer.count).toBe(1);
    expect(outcomeAt(answer, '../outside.md')).toMatchObject({ outcome: 'refused', error: 'invalid_entry' });
    expect(outcomeAt(answer, '/rooted.md')).toMatchObject({ outcome: 'refused', error: 'invalid_entry' });
    expect(outcomeAt(answer, `${KB_DIR}/Drop/inside.md`)).toMatchObject({ outcome: 'created' });
    // Nothing landed beside the destination.
    expect(await readdir(join(tempDir, KB_DIR, 'Drop'))).toEqual(['inside.md']);
    expect(await readdir(join(tempDir, KB_DIR))).toEqual(['Drop']);
  });

  it('refuses a zip entry that is a symbolic link, and lands the others', async () => {
    const base = await start();
    const { token } = await request(base);
    const zip = new AdmZip();
    zip.addFile('link.md', Buffer.from('../../etc/passwd'));
    // The unix mode a zip records for a symbolic link (`S_IFLNK | 0777`), in
    // the high half of the external attributes.
    const entry = zip.getEntry('link.md');
    if (entry) entry.header.attr = ((0o120000 | 0o777) << 16) >>> 0;
    zip.addFile('real.md', Buffer.from('real'));
    await send(base, token, 'links.zip', zip.toBuffer());
    const answer = await apply(base, { branch: DRAFT, token, destination: `${KB_DIR}/Drop` });
    expect(outcomeAt(answer, 'link.md')).toMatchObject({ outcome: 'refused', error: 'link' });
    expect(outcomeAt(answer, `${KB_DIR}/Drop/real.md`)).toMatchObject({ outcome: 'created' });
    expect(await readdir(join(tempDir, KB_DIR, 'Drop'))).toEqual(['real.md']);
  });

  it('refuses an entry whose path goes through a symbolic link already on disk', async () => {
    const base = await start();
    await mkdir(join(tempDir, KB_DIR, 'Real'), { recursive: true });
    await mkdir(join(tempDir, 'outside'), { recursive: true });
    await symlink(join(tempDir, 'outside'), join(tempDir, KB_DIR, 'Away'), 'dir');
    const { token } = await request(base);
    await send(base, token, 'drop.zip', zipOf({ 'Away/x.md': 'away', 'Real/y.md': 'real' }));
    const answer = await apply(base, { branch: DRAFT, token, destination: KB_DIR });
    expect(outcomeAt(answer, `${KB_DIR}/Away/x.md`)).toMatchObject({ outcome: 'refused', error: 'symlink' });
    expect(outcomeAt(answer, `${KB_DIR}/Real/y.md`)).toMatchObject({ outcome: 'created' });
    expect(await readdir(join(tempDir, 'outside'))).toEqual([]);
  });

  it('refuses an entry naming the git folder, and lands the others', async () => {
    const base = await start();
    const { token } = await request(base);
    await send(base, token, 'drop.zip', zipOf({ '.git/config': 'evil', 'fine.md': 'fine' }));
    const answer = await apply(base, { branch: DRAFT, token, destination: `${KB_DIR}/Drop` });
    expect(outcomeAt(answer, '.git/config')).toMatchObject({ outcome: 'refused', error: 'invalid_entry' });
    expect(outcomeAt(answer, `${KB_DIR}/Drop/fine.md`)).toMatchObject({ outcome: 'created' });
  });

  it('refuses a SINGLE file named after the git folder as that path\'s own outcome', async () => {
    const base = await start();
    const { token } = await request(base);
    // `.git` is a name `validateFilename` accepts, so the upload route lets it
    // through; it reaches the apply as a name of the upload's, not of the
    // call's, so the preflight that reads the caller's arguments never sees it.
    // Judged per path, like every other refusal, rather than failing the whole
    // apply from inside the batch write.
    await send(base, token, '.git', Buffer.from('evil'));
    const answer = await apply(base, { branch: DRAFT, token, destination: `${KB_DIR}/Drop` });
    expect(answer.count).toBe(0);
    expect(outcomeAt(answer, `${KB_DIR}/Drop/.git`)).toMatchObject({
      outcome: 'refused',
      error: 'git-internals',
    });
    expect(batches).toEqual([]);
  });

  it('refuses an entry that CLAIMS more than one commit lands, without inflating it', async () => {
    const base = await start();
    const { token } = await request(base);
    // 200 MB declared against a 128 MB apply budget. Judged on the header,
    // before `getData`, because a deflate stream expands by three orders of
    // magnitude and an entry inflated to be measured is an entry already held
    // in memory. The bytes behind this header are a handful.
    const bomb = zipWithDeclaredSize('bomb.md', 'tiny', 200 * 1024 * 1024);
    await send(base, token, 'bomb.zip', bomb);
    const answer = await apply(base, { branch: DRAFT, token, destination: `${KB_DIR}/Bomb` });
    expect(outcomeAt(answer, 'bomb.md')).toMatchObject({ outcome: 'refused', error: 'too_large' });
    expect(outcomeAt(answer, 'bomb.md')?.message).toContain('one commit');
    expect(batches).toEqual([]);
  });

  // Scenario: a zip holds 60 entries.
  it('lists 25 paths with the total, and all of them when asked', async () => {
    const base = await start();
    const { token } = await request(base);
    const entries: Record<string, string> = {};
    for (let i = 0; i < 60; i++) entries[`f${String(i).padStart(2, '0')}.md`] = `file ${i}\n`;
    await send(base, token, 'many.zip', zipOf(entries));
    const cut = await apply(base, { branch: DRAFT, token, destination: `${KB_DIR}/Many` });
    expect(cut.total).toBe(60);
    expect(cut.count).toBe(60);
    expect(cut.files).toHaveLength(25);
    expect(cut.truncated).toBe(true);
    // Every one of the 60 landed, even though only 25 are named.
    expect(await readdir(join(tempDir, KB_DIR, 'Many'))).toHaveLength(60);

    const { token: second } = await request(base);
    await send(base, second, 'many.zip', zipOf(entries));
    const all = await apply(base, {
      branch: DRAFT,
      token: second,
      destination: `${KB_DIR}/Many`,
      mode: 'overwrite',
      all: true,
    });
    expect(all.total).toBe(60);
    expect(all.files).toHaveLength(60);
    expect(all.truncated).toBeUndefined();
  });

  it('drops a macOS archive\'s sidecar entries without reporting them', async () => {
    const base = await start();
    const { token } = await request(base);
    await send(base, token, 'mac.zip', zipOf({
      '__MACOSX/._SKILL.md': 'junk',
      '.DS_Store': 'junk',
      'SKILL.md': '# real\n',
    }));
    const answer = await apply(base, { branch: DRAFT, token, destination: `${KB_DIR}/Drop` });
    expect(answer.total).toBe(1);
    expect(answer.files).toEqual([{ path: `${KB_DIR}/Drop/SKILL.md`, outcome: 'created' }]);
  });

  it('refuses a destination that is a file, not a folder', async () => {
    const base = await start();
    await mkdir(join(tempDir, KB_DIR), { recursive: true });
    await writeFile(join(tempDir, KB_DIR, 'page.md'), 'page');
    const { token } = await request(base);
    await send(base, token, 'a.md', Buffer.from('a'));
    const res = await call(base, 'apply_file_upload', {
      branch: DRAFT,
      token,
      destination: `${KB_DIR}/page.md`,
    });
    expect(res.status).toBe(409);
    expect((await json<{ error: string }>(res)).error).toContain('is a file, not a folder');
  });

  it('refuses a destination outside the repository', async () => {
    const base = await start();
    const { token } = await request(base);
    await send(base, token, 'a.md', Buffer.from('a'));
    // The normaliser PLACES an unprefixed path under the checkout, so the
    // refusal is about one that cannot be rescued by any spelling.
    const res = await call(base, 'apply_file_upload', {
      branch: DRAFT,
      token,
      destination: `${KB_DIR}/../beside`,
    });
    expect(res.status).toBe(400);
    expect(batches).toEqual([]);
  });

  it('refuses an apply with no token at all', async () => {
    const base = await start();
    const res = await call(base, 'apply_file_upload', { branch: DRAFT, destination: KB_DIR });
    expect(res.status).toBe(400);
  });

  it('refuses a token whose bytes were never sent', async () => {
    const base = await start();
    const { token } = await request(base);
    const res = await call(base, 'apply_file_upload', { branch: DRAFT, token, destination: KB_DIR });
    expect(res.status).toBe(404);
    expect((await json<{ error: string }>(res)).error).toBe(UPLOAD_TOKEN_REFUSAL);
  });
});

describe('a token is good once, for one user, for a limited time', () => {
  it('is refused the second time it is applied', async () => {
    const base = await start();
    const { token } = await request(base);
    await send(base, token, 'a.md', Buffer.from('a'));
    expect((await apply(base, { branch: DRAFT, token, destination: `${KB_DIR}/One` })).count).toBe(1);
    const second = await call(base, 'apply_file_upload', {
      branch: DRAFT,
      token,
      destination: `${KB_DIR}/Two`,
      mode: 'overwrite',
    });
    expect(second.status).toBe(404);
    expect((await json<{ error: string }>(second)).error).toBe(UPLOAD_TOKEN_REFUSAL);
    expect(await readdir(join(tempDir, KB_DIR))).toEqual(['One']);
  });

  it('deletes the stored bytes once it has been applied', async () => {
    const base = await start();
    const { token } = await request(base);
    await send(base, token, 'a.md', Buffer.from('a'));
    expect(await readdir(uploadsDir)).toHaveLength(1);
    await apply(base, { branch: DRAFT, token, destination: KB_DIR });
    expect(await readdir(uploadsDir)).toEqual([]);
  });

  it('is refused when another user presents it, saying nothing about whether it exists', async () => {
    const owner = await start({ userId: 'owner', userEmail: 'owner@x' });
    const { token } = await request(owner);
    await send(owner, token, 'a.md', Buffer.from('a'));
    // A second caller on the SAME server's store — a different connection key.
    const stranger = await start({ userId: 'stranger', userEmail: 'stranger@x', store: uploads });
    const refused = await call(stranger, 'apply_file_upload', {
      branch: DRAFT,
      token,
      destination: `${KB_DIR}/Theirs`,
    });
    expect(refused.status).toBe(404);
    const { error } = await json<{ error: string }>(refused);
    expect(error).toBe(UPLOAD_TOKEN_REFUSAL);
    // Says nothing about whether the token exists — the same sentence an
    // invented token gets, so a stranger learns nothing from the difference.
    const invented = await call(stranger, 'apply_file_upload', {
      branch: DRAFT,
      token: 'bevel-up_invented',
      destination: `${KB_DIR}/Theirs`,
    });
    expect((await json<{ error: string }>(invented)).error).toBe(error);
    expect(batches).toEqual([]);
    // And the stranger's attempt did not spend it: the owner still can.
    expect((await apply(owner, { branch: DRAFT, token, destination: `${KB_DIR}/Mine` })).count).toBe(1);
  });

  it('is refused once it has expired, and the stored upload is gone', async () => {
    // A TTL comfortably longer than the two HTTP round-trips below: at 30ms a
    // loaded machine could expire the token mid-`send`, and the test would
    // fail on an upload that was never stored rather than on the expiry it is
    // about.
    const base = await start({ ttlMs: 1_000 });
    const { token } = await request(base);
    await send(base, token, 'a.md', Buffer.from('a'));
    expect(await readdir(uploadsDir)).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 1_500));
    const res = await call(base, 'apply_file_upload', { branch: DRAFT, token, destination: KB_DIR });
    expect(res.status).toBe(404);
    expect((await json<{ error: string }>(res)).error).toBe(UPLOAD_TOKEN_REFUSAL);
    await uploads.sweepNow();
    expect(await readdir(uploadsDir)).toEqual([]);
  });

  it('deletes an upload nobody applied, on its own, when the token expires', async () => {
    // The periodic sweep, started before the first token is issued so the
    // store's own default interval does not win the race.
    // The TTL has the same margin over the round-trips as above; the sweep
    // interval stays short, and the deadline loop below is what makes the
    // sweep-side timing robust once the send has landed.
    const base = await start({ ttlMs: 1_000, sweepEveryMs: 10 });
    const { token } = await request(base);
    await send(base, token, 'forgotten.zip', zipOf({ 'a.md': 'a' }));
    expect(await readdir(uploadsDir)).toHaveLength(1);
    const deadline = Date.now() + 6_500;
    while (Date.now() < deadline && (await readdir(uploadsDir)).length > 0) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(await readdir(uploadsDir)).toEqual([]);
    expect((await call(base, 'apply_file_upload', { branch: DRAFT, token, destination: KB_DIR })).status).toBe(404);
  });
});

describe('the sweep', () => {
  it('leaves alone the bytes of a token issued while it was listing the directory', async () => {
    // THE WINDOW, HELD OPEN. Whether a sweep running alongside a brand-new
    // upload deletes its bytes turns on the order of two steps — the listing
    // of the staging root, and the set of ids the live records hold — and in
    // production the gap between them is a filesystem round-trip no test can
    // time. So the listing is the seam: this one is paused on its way in, a
    // whole token-issue-and-upload happens inside the pause, and only then is
    // the directory read and the live set taken.
    //
    // That ordering is what makes this a test and not a hope. A sweep that
    // took its live set BEFORE listing would have taken it before the second
    // record existed, then listed a directory holding the second file, and
    // deleted bytes whose sender had just been answered "received".
    let reached: () => void = () => undefined;
    const listing = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let release: () => void = () => undefined;
    let barrier: Promise<void> | null = null;
    const base = await start({
      listRoot: async (root) => {
        if (barrier !== null) {
          const held = barrier;
          barrier = null; // one-shot: only the sweep this test arms is held
          reached();
          await held;
        }
        return readdir(root);
      },
    });
    const first = await request(base);
    await send(base, first.token, 'first.md', Buffer.from('first'));

    barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sweeping = uploads.sweepNow();
    await listing;
    const second = await request(base);
    const landed = await send(base, second.token, 'second.md', Buffer.from('second'));
    release();
    await sweeping;

    expect(landed.status).toBe(200);
    expect(await readdir(uploadsDir)).toHaveLength(2);
    // And both are still applicable — the sweep took neither record with it.
    expect((await apply(base, { branch: DRAFT, token: first.token, destination: `${KB_DIR}/A` })).count).toBe(1);
    expect((await apply(base, { branch: DRAFT, token: second.token, destination: `${KB_DIR}/B` })).count).toBe(1);
  });

  it('refuses an upload whose token expired while the body was still arriving', async () => {
    // The TTL passes mid-request, and the periodic sweep fires inside it. The
    // answer is the one refusal rather than a success the sender could do
    // nothing with — and nothing is left staged.
    const base = await start({ ttlMs: 250, sweepEveryMs: 20 });
    const { token } = await request(base);
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        await new Promise((r) => setTimeout(r, 600));
        controller.enqueue(new Uint8Array([4, 5, 6]));
        controller.close();
      },
    });
    const res = await fetch(`${base}/api/agent/uploads/${encodeURIComponent(token)}?filename=slow.bin`, {
      method: 'POST',
      body,
      // Node's fetch requires this for a streamed request body.
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    expect(res.status).toBe(404);
    expect((await json<{ error: string }>(res)).error).toBe(UPLOAD_TOKEN_REFUSAL);
    await uploads.drainSweep();
    expect(await readdir(uploadsDir)).toEqual([]);
  });

  it('leaves the bytes an apply is holding alone, even past the expiry', async () => {
    const base = await start({ ttlMs: 1_000 });
    const { token } = await request(base);
    await send(base, token, 'slow.md', Buffer.from('slow'));
    // Exactly what an apply holds while it resolves the branch, reads the
    // bytes, judges every path and commits — work that can outlast a token
    // whose TTL was nearly up when it started. A sweep that deleted the source
    // here would make the commit land short with nothing saying why.
    const claimed = uploads.claim(token, 'u');
    await new Promise((r) => setTimeout(r, 1_200));
    await uploads.sweepNow();
    expect(await readFile(claimed.absolutePath, 'utf8')).toBe('slow');
    // And a second apply arriving meanwhile still finds the token unusable.
    expect(() => uploads.claim(token, 'u')).toThrow(UPLOAD_TOKEN_REFUSAL);
    // Released without landing anything, the claim is gone and so are the bytes.
    uploads.release(token);
    await uploads.sweepNow();
    expect(await readdir(uploadsDir)).toEqual([]);
  });

  it('runs once the moment it starts, so bytes a dead process left behind go now', async () => {
    const base = await start();
    // A file no record of THIS store names: what a restart finds, since the
    // records live in memory and went with the process that issued them.
    await writeFile(join(uploadsDir, 'upload-from-a-dead-process'), 'orphan');
    const { token } = await request(base);
    await uploads.drainSweep();
    expect(await readdir(uploadsDir)).toEqual([]);
    // The token issued alongside it is untouched — the sweep reclaims by what
    // the live records do NOT name.
    expect((await send(base, token, 'a.md', Buffer.from('a'))).status).toBe(200);
  });

  it('stops deleting once it is stopped, so an evicted graph cannot sweep its replacement', async () => {
    await start();
    uploads.stopSweeping();
    await writeFile(join(uploadsDir, 'upload-the-next-store-issued'), 'theirs');
    await uploads.sweepNow();
    expect(await readdir(uploadsDir)).toEqual(['upload-the-next-store-issued']);
  });
});

describe('the staging root', () => {
  it('refuses a boot that would stage uploads inside a workspace', async () => {
    const workspaces = await mkdtemp(join(tmpdir(), 'ws-root-'));
    try {
      for (const inside of [workspaces, join(workspaces, 'agent-uploads'), join(workspaces, 'a', 'b')]) {
        await expect(assertUploadsRootOutsideWorkspaces(inside, workspaces)).rejects.toThrow(
          /AGENT_UPLOADS_ROOT/,
        );
      }
      // Through a LINK, too: where the path resolves to is what decides it.
      const linked = join(workspaces, '..', `link-${basename(workspaces)}`);
      await symlink(workspaces, linked);
      try {
        await expect(assertUploadsRootOutsideWorkspaces(join(linked, 'uploads'), workspaces)).rejects.toThrow(
          /AGENT_UPLOADS_ROOT/,
        );
      } finally {
        await rm(linked, { force: true });
      }
      // A sibling — the default — is what the invariant asks for.
      await assertUploadsRootOutsideWorkspaces(join(workspaces, '..', 'agent-uploads'), workspaces);
    } finally {
      await rm(workspaces, { recursive: true, force: true });
    }
  });
});

describe('an upload is never readable through a file tool', () => {
  it('sits outside every workspace, and no path reaches it', async () => {
    const base = await start();
    const { token } = await request(base);
    await send(base, token, 'secret.md', Buffer.from('held outside'));
    const [stored] = await readdir(uploadsDir);
    // Not in the workspace tree at all.
    const names = await json<{ entries: { name: string }[] }>(
      await call(base, 'list_files', { branch: DRAFT, path: KB_DIR }),
    );
    expect((names.entries ?? []).map((e) => e.name)).not.toContain(stored);
    // And no spelling of a workspace path leaves the repository to find it.
    for (const path of [`${KB_DIR}/../../agent-uploads/${stored}`, `../${stored}`, `/${stored}`]) {
      const res = await call(base, 'read_file', { branch: DRAFT, path });
      expect(res.status).not.toBe(200);
    }
  });
});

describe('the write tools name the upload route', () => {
  it('says so on write_file, write_files and edit_file', async () => {
    await start();
    const tools = await toolRegistry.listExternal();
    for (const name of ['write_file', 'write_files', 'edit_file']) {
      const def = tools.find((t) => t.name === name);
      expect(def, name).toBeDefined();
      const description = def!.description;
      expect(description, name).toContain('request_file_upload');
      expect(description, name).toContain('apply_file_upload');
      // The three cases the route exists for are named, not just the tools.
      expect(description, name).toMatch(/truncated/i);
      expect(description, name).toMatch(/escape/i);
      expect(description, name).toMatch(/zip/i);
    }
  });
});

describe('the token travels in the path or in a header', () => {
  /** POST bytes to the BARE address, the token in `x-upload-token`. */
  const sendWithHeader = (
    base: string,
    token: string,
    filename: string,
    data: Buffer,
    contentType = 'application/octet-stream',
  ) =>
    fetch(`${base}/api/agent/uploads?filename=${encodeURIComponent(filename)}`, {
      method: 'POST',
      headers: { 'content-type': contentType, 'x-upload-token': token },
      body: data,
    });

  it('takes the token as a header on the bare address, and the apply lands those bytes', async () => {
    const base = await start();
    const { token } = await request(base);
    const res = await sendWithHeader(base, token, 'notes.md', Buffer.from('hello'));
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ filename: 'notes.md', bytes: 5, kind: 'file' });
    const answer = await apply(base, { branch: DRAFT, token, destination: `${KB_DIR}/Pages` });
    expect(answer.files).toEqual([{ path: `${KB_DIR}/Pages/notes.md`, outcome: 'created' }]);
    expect(await readFile(join(tempDir, KB_DIR, 'Pages/notes.md'), 'utf8')).toBe('hello');
  });

  it('keeps the bytes a stream on the bare address too, whatever content-type is claimed', async () => {
    const base = await start();
    const { token } = await request(base);
    // The global `express.json()` would drain this body — the header form has
    // to be exempt by the same rule the path form is, or a zip sent as
    // `application/json` reaches the handler with nothing left in it.
    const zip = zipOf({ 'a.md': 'a' });
    const res = await sendWithHeader(base, token, 'archive.zip', zip, 'application/json');
    expect(await json(res)).toEqual({ filename: 'archive.zip', bytes: zip.byteLength, kind: 'zip', entries: 1 });
  });

  it('exempts both spellings of the address from the JSON parser', () => {
    expect(isAgentUploadRawBodyPath('/api/agent/uploads')).toBe(true);
    expect(isAgentUploadRawBodyPath('/api/agent/uploads/')).toBe(true);
    expect(isAgentUploadRawBodyPath('/API/Agent/Uploads')).toBe(true);
    expect(isAgentUploadRawBodyPath('/api/agent/uploads/bevel-up_abc')).toBe(true);
    expect(isAgentUploadRawBodyPath('/api/agent/uploadsomething')).toBe(false);
    expect(isAgentUploadRawBodyPath('/api/agent/tools/write_file')).toBe(false);
  });

  it('gives the bare address with NO token the same single refusal an unknown token gets', async () => {
    const base = await start();
    const bare = await fetch(`${base}/api/agent/uploads?filename=notes.md`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: Buffer.from('hello'),
    });
    const unknown = await send(base, 'bevel-up_nosuchtoken', 'notes.md', Buffer.from('hello'));
    expect(bare.status).toBe(404);
    expect(unknown.status).toBe(404);
    // The same words: a caller holding no token learns nothing from the
    // difference, not even that a header would have been read.
    expect(await json(bare)).toEqual(await json(unknown));
  });

  it('lets the path win when a stale header names a different token', async () => {
    const base = await start();
    const first = await request(base);
    const second = await request(base);
    const res = await fetch(`${base}/api/agent/uploads/${encodeURIComponent(first.token)}?filename=notes.md`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'x-upload-token': second.token },
      body: Buffer.from('hello'),
    });
    expect(res.status).toBe(200);
    // The bytes belong to the token in the address that was POSTed to; the
    // other token is still open and still holds nothing.
    const landed = await apply(base, { branch: DRAFT, token: first.token, destination: `${KB_DIR}/Pages` });
    expect(landed.files).toEqual([{ path: `${KB_DIR}/Pages/notes.md`, outcome: 'created' }]);
    const empty = await apply(base, { branch: DRAFT, token: second.token, destination: `${KB_DIR}/Pages` });
    expect(empty.error).toBeDefined();
  });
});

describe('an apply takes the destination folder\'s turn', () => {
  it('lands its batch INSIDE the turn, over the destination it was given', async () => {
    const base = await start();
    const { token } = await request(base);
    await send(base, token, 'skill.zip', zipOf({ 'SKILL.md': '# s\n', 'docs/a.md': 'a' }));
    await apply(base, { branch: DRAFT, token, destination: `${KB_DIR}/Skills/my-skill` });
    // One turn, over the destination — the same folder `delete_folder` takes
    // its turn over, which is what makes the two wait for each other.
    expect(folderTurns).toEqual([`${KB_DIR}/Skills/my-skill`]);
    // And the batch landed while that turn was held, not before or after it:
    // a turn taken around nothing would serialise nothing.
    expect(batchTurnDepth).toEqual([1]);
  });

  it('lands nothing while another caller holds a turn over that subtree', async () => {
    const base = await start();
    const { token } = await request(base);
    await send(base, token, 'page.md', Buffer.from('mine\n'));
    // The turn a concurrent `delete_folder` would be holding over the
    // destination, held open until this test lets go.
    let release!: () => void;
    folderTurnGate = new Promise<void>((resolve) => (release = resolve));
    const pending = apply(base, { branch: DRAFT, token, destination: `${KB_DIR}/Pages` });
    // Until the apply ASKS for the turn — no sleep, so a loaded runner cannot
    // turn this into a flake, and nothing here depends on how long the judging
    // took. Racing the apply itself means a regression that never asks for a
    // turn fails on the assertions below instead of hanging to the timeout.
    await Promise.race([folderTurnAsked, pending]);
    // Asked for, and not yet granted: the apply is parked on the gate, which
    // is what makes every assertion that follows a statement about waiting.
    expect(folderTurns).toEqual([`${KB_DIR}/Pages`]);
    expect(turnsHeld).toBe(0);
    expect(batches).toEqual([]);
    await expect(readFile(join(tempDir, KB_DIR, 'Pages/page.md'), 'utf8')).rejects.toThrow();
    // Now the folder is free, and the same apply finishes on it.
    release();
    const answer = await pending;
    expect(answer.files).toEqual([{ path: `${KB_DIR}/Pages/page.md`, outcome: 'created' }]);
    expect(batches).toHaveLength(1);
    expect(await readFile(join(tempDir, KB_DIR, 'Pages/page.md'), 'utf8')).toBe('mine\n');
  });
});

describe('a read-only deployment lands no upload', () => {
  /** A host's verdict: the deployment may be read, not changed. */
  const readOnly: IWriteAccess = {
    canWrite: async () => ({ ok: false, message: 'This workspace is read-only until an admin adds seats.' }),
  };

  /**
   * Both upload tools must be WRITE tools, because the read-only gate's HTTP
   * half cannot refuse them: `/api/agent/` is on its always-writable list, on
   * the stated grounds that "every tool call is judged by the tool layer
   * itself, which knows a write tool from a read". That makes `write: true` on
   * these two mounts the only thing standing between a read-only deployment
   * and a commit — worth a test that fails if either loses the flag, rather
   * than a comment hoping nobody does.
   */
  it('refuses request_file_upload and apply_file_upload at the tool layer', async () => {
    const base = await start({ writeAccess: readOnly });
    for (const tool of ['request_file_upload', 'apply_file_upload']) {
      const res = await call(base, tool, { branch: DRAFT, token: 'bevel-up_x', destination: KB_DIR });
      expect(res.status, tool).toBe(403);
      expect(await json<{ code?: string }>(res), tool).toMatchObject({ code: READ_ONLY_CODE });
    }
  });

  /**
   * The raw upload route is NOT a tool and never reaches the tool layer, so
   * the always-writable prefix does let its bytes through. That is harmless
   * and deliberate: it stages bytes beside the workspaces root and commits
   * nothing, no new token can be issued while the deployment is read-only
   * (`request_file_upload` is refused above), and bytes nobody can apply are
   * deleted when their token expires. Asserted so the reasoning is on record
   * where the behaviour is.
   */
  it('still takes the bytes of a token issued before the deployment went read-only, and lands none of them', async () => {
    const writable = await start();
    const { token } = await request(writable);
    const readOnlyServer = await start({ store: uploads, writeAccess: readOnly });
    expect((await send(readOnlyServer, token, 'notes.md', Buffer.from('hello'))).status).toBe(200);
    const refused = await call(readOnlyServer, 'apply_file_upload', {
      branch: DRAFT,
      token,
      destination: `${KB_DIR}/Pages`,
    });
    expect(refused.status).toBe(403);
    expect(batches).toEqual([]);
    await expect(readFile(join(tempDir, KB_DIR, 'Pages/notes.md'), 'utf8')).rejects.toThrow();
  });
});
