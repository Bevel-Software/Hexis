import type { Server as HttpServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { AgentUploadStore, UPLOAD_TOKEN_REFUSAL } from '../agent-upload.store.js';
import { createAgentUploadRoutes, isAgentUploadRawBodyPath } from '../agent-upload.routes.js';
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

interface StartOptions {
  access?: IAccessControl;
  userId?: string;
  userEmail?: string;
  ttlMs?: number;
  maxBytes?: number;
  /** Start the periodic sweep at this interval BEFORE any token is issued. */
  sweepEveryMs?: number;
  /**
   * Mount against a store that is already running, so a second server can
   * stand for a second caller — a different connection key, the same server's
   * store — without the first one's state being thrown away.
   */
  store?: AgentUploadStore;
}

async function start(options: StartOptions = {}): Promise<string> {
  const { access = allowAll, userId = 'u', userEmail = 'e@x' } = options;
  if (options.store === undefined) {
    tempDir = await mkdtemp(join(tmpdir(), 'ws-upload-'));
    uploadsDir = await mkdtemp(join(tmpdir(), 'agent-uploads-'));
    docCacheDir = await mkdtemp(join(tmpdir(), 'ws-upload-doc-'));
    batches = [];
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
    } as never,
    workflowService: {} as never,
    events: {} as never,
    getFilesystem: async () => fs,
  });
  const toolHandler = createToolHandlerFactory(resolve);
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
    const base = await start({ ttlMs: 30 });
    const { token } = await request(base);
    await send(base, token, 'a.md', Buffer.from('a'));
    expect(await readdir(uploadsDir)).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 60));
    const res = await call(base, 'apply_file_upload', { branch: DRAFT, token, destination: KB_DIR });
    expect(res.status).toBe(404);
    expect((await json<{ error: string }>(res)).error).toBe(UPLOAD_TOKEN_REFUSAL);
    await uploads.sweepNow();
    expect(await readdir(uploadsDir)).toEqual([]);
  });

  it('deletes an upload nobody applied, on its own, when the token expires', async () => {
    // The periodic sweep, started before the first token is issued so the
    // store's own default interval does not win the race.
    const base = await start({ ttlMs: 30, sweepEveryMs: 10 });
    const { token } = await request(base);
    await send(base, token, 'forgotten.zip', zipOf({ 'a.md': 'a' }));
    expect(await readdir(uploadsDir)).toHaveLength(1);
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && (await readdir(uploadsDir)).length > 0) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(await readdir(uploadsDir)).toEqual([]);
    expect((await call(base, 'apply_file_upload', { branch: DRAFT, token, destination: KB_DIR })).status).toBe(404);
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
