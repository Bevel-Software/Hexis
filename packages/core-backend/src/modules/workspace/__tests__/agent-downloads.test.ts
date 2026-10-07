import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import AdmZip from 'adm-zip';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalFilesystem } from '@mastra/core/workspace';
import { DEFAULT_KB_LAYOUT } from '@bevel-software/platform-shared';
import { testKbContext } from '../../../__tests__/kb-context.js';
import { NodeFs } from '../../kb-fs/node-fs.js';
import { AccessControlService } from '../../access/access-control.service.js';
import { ToolRegistry } from '../../tool-registry/tool-registry.js';
import { createToolHandlerFactory } from '../../tool-helpers/tool-handler.js';
import { ToolError, type ToolContext } from '../../tool-helpers/tool.contract.js';
import type { ToolAuth } from '../../tool-auth/tool-auth.middleware.js';
import { registerWorkspaceTools } from '../workspace.tools.js';
import { RoutineWritePolicyService } from '../routine-write-policy.js';
import { WorkflowHooks } from '../../workflow/workflow-hooks.js';
import { ToolDescriptionNotes } from '../agent-access.gate.js';
import { SpillStore } from '../spill-store.js';
import { DocExtractService } from '../file-readers/doc-extract.service.js';
import { WorkspaceService } from '../workspace.service.js';
import { workspaceIdForBranch } from '../../../shared/workspace-id.js';
import { AgentDownloadStore, DOWNLOAD_TOKEN_REFUSAL } from '../agent-download.store.js';
import { createAgentDownloadRoutes } from '../agent-download.routes.js';
import { buildDownload, DOWNLOAD_PERMISSION_REQUIRED, NOT_FOUND } from '../agent-download.builder.js';
import { READ_ONLY_CODE, type IWriteAccess } from '../../write-access/write-access.js';
import { sharedFileRules } from '../../agent-instructions/shared-file-rules.js';

/**
 * `request_file_download` end to end, over the REAL access resolver on a
 * temporary knowledge base: every file judged on its own, a link per file and
 * a zip per folder, each link answering once.
 *
 * The four files under `Shared/` are the cases verified leaking from the app's
 * folder zip (2026-10-07): a file denying `download`, one denying `read`, a
 * nested `access.md` denying both, and a plain file. Ana holds `download` on
 * the folder; only the plain file (and the grant file itself) may go out.
 */

const KB = 'knowledge-base';
const BRANCH = 'draft';
const PUBLIC_BASE = 'https://kb.example.com';
const ANA = { id: 'user-ana', email: 'ana@x.io', name: 'Ana' };

/** Not a real PNG, but bytes no text reader would take for text. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x10, 0x80, 0x00, 0x01]);

const FILES: Record<string, string | Buffer> = {
  'roles.yaml': 'roles:\n  Admin:\n    - admin@x.io\n',
  'Shared/access.md': '---\n---\ndownload:\n  - Ana <ana@x.io>\n',
  'Shared/Open.md': '# open\n',
  'Shared/Node-Deny-Download.md': '---\ndownload:\n  - deny Ana <ana@x.io>\n---\n# no save\n',
  'Shared/Node-Deny-Read.md': '---\nread:\n  - deny Ana <ana@x.io>\n---\n# hidden\n',
  'Shared/Inner/access.md': '---\n---\nread:\n  - deny Ana <ana@x.io>\ndownload:\n  - deny Ana <ana@x.io>\n',
  'Shared/Inner/Plan.md': '# hidden plan\n',
  // Ana may read here, and download nothing.
  'Readable/access.md': '---\n---\nread:\n  - Ana <ana@x.io>\n',
  'Readable/Top.md': '# top\n',
  'Pictures/access.md': '---\n---\ndownload:\n  - Ana <ana@x.io>\n',
  'Pictures/logo.png': PNG,
  'Pictures/sub/.gitkeep': '',
  'Pictures/.bevelignore': 'Ignored.md\n',
  'Pictures/Ignored.md': '# ignored\n',
};

const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

interface Started {
  base: string;
  repo: string;
  downloadsRoot: string;
  store: AgentDownloadStore;
  readsHooked: string[];
}

interface StartOptions {
  files?: Record<string, string | Buffer>;
  scope?: 'read' | 'write';
  writeAccess?: IWriteAccess;
  ttlMs?: number;
  maxOpenPerUser?: number;
  /** Paths the deployment's read hook refuses. */
  hookRefuses?: (wsPath: string) => boolean;
}

let servers: HttpServer[] = [];
let dirs: string[] = [];

afterEach(async () => {
  for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
  servers = [];
  for (const d of dirs) await rm(d, { recursive: true, force: true });
  dirs = [];
  vi.useRealTimers();
});

async function start(options: StartOptions = {}): Promise<Started> {
  const root = await mkdtemp(join(tmpdir(), 'agent-dl-ws-'));
  const downloadsRoot = await mkdtemp(join(tmpdir(), 'agent-dl-store-'));
  const docCache = await mkdtemp(join(tmpdir(), 'agent-dl-doc-'));
  dirs.push(root, downloadsRoot, docCache);
  const workspaceDir = join(root, workspaceIdForBranch(BRANCH));
  const repo = join(workspaceDir, KB);
  // A `.git` folder is what makes the service adopt the clone without cloning.
  await mkdir(join(repo, '.git'), { recursive: true });
  await writeFile(join(repo, '.git', 'config'), '[core]\n');
  for (const [rel, contents] of Object.entries(options.files ?? FILES)) {
    const abs = join(repo, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, contents);
  }
  const workspaceService = new WorkspaceService(
    root,
    'https://example.invalid/kb.git',
    testKbContext({ kbDirName: KB }),
    new NodeFs(),
  );
  const accessControl = new AccessControlService(workspaceService, KB, new NodeFs());
  const store = new AgentDownloadStore({
    root: downloadsRoot,
    publicBaseUrl: PUBLIC_BASE,
    tokenPrefix: 'bevel-down_',
    ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}),
    ...(options.maxOpenPerUser !== undefined ? { maxOpenPerUser: options.maxOpenPerUser } : {}),
  });
  const hooks = new WorkflowHooks();
  const readsHooked: string[] = [];
  hooks.onAgentRead(async (op) => {
    readsHooked.push(op.wsPath ?? '');
    if (op.wsPath && options.hookRefuses?.(op.wsPath)) {
      throw new ToolError(`This session may not read ${op.wsPath}.`, 403);
    }
  });
  const fs = new LocalFilesystem({ basePath: workspaceDir, contained: true });
  const resolve = async (auth: ToolAuth, signal: AbortSignal, sessionId?: string): Promise<ToolContext> => ({
    user: ANA,
    scope: auth.scope,
    source: auth.source,
    sessionId,
    abortSignal: signal,
    workspaceService,
    workflowService: {} as never,
    events: {} as never,
    getFilesystem: async () => fs,
  });
  const toolHandler =
    options.writeAccess !== undefined
      ? createToolHandlerFactory(resolve, options.writeAccess)
      : createToolHandlerFactory(resolve);
  const fakeAuth = (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.toolAuth = { source: 'external', userId: ANA.id, scope: options.scope ?? 'write' };
    next();
  };
  const app = express();
  app.use(express.json());
  const router = express.Router();
  registerWorkspaceTools(
    new ToolRegistry(),
    router,
    fakeAuth,
    toolHandler,
    new SpillStore(join(tmpdir(), 'bevel-test-spills')),
    new DocExtractService(docCache),
    accessControl,
    testKbContext({ kbDirName: KB }),
    { recoveryBotEmail: 'recovery-bot@bevel.local', hooks, notes: new ToolDescriptionNotes() },
    new RoutineWritePolicyService(),
    {} as never,
    undefined,
    undefined,
    undefined,
    undefined,
    store,
  );
  // A fetch that says who it is: `Bearer <user id>` stands for a verified credential.
  const identify = async (req: express.Request): Promise<string | null> => {
    const h = req.headers.authorization;
    return h?.startsWith('Bearer ') ? h.slice(7) : null;
  };
  router.use(createAgentDownloadRoutes({ downloads: store, identify }));
  app.use('/api', router);
  const server = await new Promise<HttpServer>((r) => {
    const s = app.listen(0, () => r(s));
  });
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, repo, downloadsRoot, store, readsHooked };
}

interface Answer {
  expiresAt: string | null;
  expiresInSeconds: number;
  files: { path: string; bytes: number; sha256: string; downloadUrl: string }[];
  folders: { path: string; bytes: number; downloadUrl: string; files: string[] }[];
  refused: { path: string; reason: string }[];
}

async function request(base: string, paths: string[]): Promise<{ status: number; body: Answer & { error?: string; code?: string } }> {
  const res = await fetch(`${base}/api/agent/tools/request_file_download`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ branch: BRANCH, paths }),
  });
  return { status: res.status, body: (await res.json()) as never };
}

/** The deployment's address for a link the store answered with its public base URL. */
const local = (base: string, url: string): string => url.replace(PUBLIC_BASE, base);
const fetchLink = (base: string, url: string, init?: RequestInit) => fetch(local(base, url), init);

describe('request_file_download: every file judged on its own', () => {
  it('answers a single image with one link and no zip, serving its bytes as image/png', async () => {
    const h = await start();
    const { status, body } = await request(h.base, [`${KB}/Pictures/logo.png`]);

    expect(status).toBe(200);
    expect(body.folders).toEqual([]);
    expect(body.refused).toEqual([]);
    expect(body.files).toHaveLength(1);
    expect(body.files[0]).toMatchObject({ path: `${KB}/Pictures/logo.png`, bytes: PNG.byteLength, sha256: sha(PNG) });
    expect(body.files[0]!.downloadUrl.startsWith(`${PUBLIC_BASE}/api/agent/downloads/bevel-down_`)).toBe(true);
    expect(body.expiresInSeconds).toBe(900);
    expect(Date.parse(body.expiresAt!)).toBeGreaterThan(Date.now());

    const res = await fetchLink(h.base, body.files[0]!.downloadUrl);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('content-disposition')).toBe("attachment; filename*=UTF-8''logo.png");
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const got = Buffer.from(await res.arrayBuffer());
    expect(got.equals(PNG)).toBe(true);
    expect(sha(got)).toBe(body.files[0]!.sha256);
  });

  it('includes only the plain file from the folder-zip leak cases, and says why for each of the rest', async () => {
    const h = await start();
    const { status, body } = await request(h.base, [`${KB}/Shared`]);

    expect(status).toBe(200);
    expect(body.files.map((f) => f.path).sort()).toEqual([`${KB}/Shared/Open.md`, `${KB}/Shared/access.md`]);
    expect([...body.refused].sort((a, b) => (a.path < b.path ? -1 : 1))).toEqual([
      { path: `${KB}/Shared/Inner/Plan.md`, reason: NOT_FOUND },
      { path: `${KB}/Shared/Inner/access.md`, reason: NOT_FOUND },
      { path: `${KB}/Shared/Node-Deny-Download.md`, reason: DOWNLOAD_PERMISSION_REQUIRED },
      { path: `${KB}/Shared/Node-Deny-Read.md`, reason: NOT_FOUND },
    ]);
    // A hidden file is answered exactly as a missing one.
    const missing = await request(h.base, [`${KB}/Shared/Nope.md`]);
    expect(missing.body.refused).toEqual([{ path: `${KB}/Shared/Nope.md`, reason: NOT_FOUND }]);

    // One zip for the folder, its entries at their full repository paths.
    expect(body.folders).toHaveLength(1);
    const folder = body.folders[0]!;
    expect(folder.path).toBe(`${KB}/Shared`);
    expect([...folder.files].sort()).toEqual([`${KB}/Shared/Open.md`, `${KB}/Shared/access.md`]);
    const res = await fetchLink(h.base, folder.downloadUrl);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(res.headers.get('content-disposition')).toBe("attachment; filename*=UTF-8''Shared.zip");
    expect(res.headers.get('cache-control')).toBe('no-store');
    const zip = new AdmZip(Buffer.from(await res.arrayBuffer()));
    const entries = zip.getEntries().map((e) => e.entryName).sort();
    expect(entries).toEqual(['Shared/Open.md', 'Shared/access.md']);
    // Every entry hashes as the manifest says.
    for (const f of body.files) {
      expect(sha(zip.getEntry(f.path.slice(KB.length + 1))!.getData())).toBe(f.sha256);
    }
    expect(folder.bytes).toBe(body.files.reduce((n, f) => n + f.bytes, 0));
  });

  it('refuses a readable file the caller may not download, and issues no link when nothing can be included', async () => {
    const h = await start();
    const { status, body } = await request(h.base, [`${KB}/Readable/Top.md`, `${KB}/Shared/Node-Deny-Read.md`, `${KB}/Gone.md`]);

    expect(status).toBe(200);
    expect(body).toEqual({
      expiresAt: null,
      expiresInSeconds: 0,
      files: [],
      folders: [],
      refused: [
        { path: `${KB}/Gone.md`, reason: NOT_FOUND },
        { path: `${KB}/Readable/Top.md`, reason: DOWNLOAD_PERMISSION_REQUIRED },
        { path: `${KB}/Shared/Node-Deny-Read.md`, reason: NOT_FOUND },
      ],
    });
    expect(await readdir(h.downloadsRoot)).toEqual([]);
    // Nothing issued, so nothing is held open against the cap.
    expect(h.store.openRequestsOf(ANA.id)).toBe(0);
  });

  it('serves the other paths when one does not exist, and takes paths without the prefix', async () => {
    const h = await start();
    const { body } = await request(h.base, ['Missing/Thing.md', 'Shared/Open.md']);

    expect(body.refused).toEqual([{ path: `${KB}/Missing/Thing.md`, reason: NOT_FOUND }]);
    expect(body.files.map((f) => f.path)).toEqual([`${KB}/Shared/Open.md`]);
  });

  it('names a file once when it is asked for directly and inside a folder', async () => {
    const h = await start();
    const { body } = await request(h.base, [`${KB}/Shared/Open.md`, `${KB}/Shared`, `${KB}/Shared/Open.md`]);

    expect(body.files.filter((f) => f.path === `${KB}/Shared/Open.md`)).toHaveLength(1);
    expect(body.folders).toHaveLength(1);
    const zip = new AdmZip(Buffer.from(await (await fetchLink(h.base, body.folders[0]!.downloadUrl)).arrayBuffer()));
    expect(zip.getEntries().filter((e) => e.entryName === 'Shared/Open.md')).toHaveLength(1);
  });

  it('skips what the file explorer skips, and never reaches the git folder', async () => {
    const h = await start();
    const { body } = await request(h.base, [`${KB}/Pictures`, `${KB}/.git/config`]);

    const paths = body.files.map((f) => f.path);
    expect(paths).toContain(`${KB}/Pictures/logo.png`);
    expect(paths).not.toContain(`${KB}/Pictures/Ignored.md`);
    expect(paths.some((p) => p.endsWith('.gitkeep'))).toBe(false);
    expect(paths.some((p) => p.includes('.git/'))).toBe(false);
    expect(body.refused).toEqual([{ path: `${KB}/.git/config`, reason: NOT_FOUND }]);
    expect(body.folders[0]!.files).toEqual(paths);
  });

  it('serves the bytes captured at request time, not a later save', async () => {
    const h = await start();
    const { body } = await request(h.base, [`${KB}/Shared/Open.md`]);
    await writeFile(join(h.repo, 'Shared/Open.md'), '# changed after the request\n');

    const got = await (await fetchLink(h.base, body.files[0]!.downloadUrl)).text();
    expect(got).toBe('# open\n');
  });
});

describe('a download link answers once', () => {
  it('refuses a second fetch, an unknown token, and another user\'s fetch with one and the same answer', async () => {
    const h = await start();
    const { body } = await request(h.base, [`${KB}/Shared/Open.md`, `${KB}/Shared/access.md`]);
    const [first, second] = body.files;

    expect((await fetchLink(h.base, first!.downloadUrl)).status).toBe(200);
    const again = await fetchLink(h.base, first!.downloadUrl);
    const unknown = await fetch(`${h.base}/api/agent/downloads/bevel-down_not-a-token`);
    const foreign = await fetchLink(h.base, second!.downloadUrl, { headers: { authorization: 'Bearer user-mallory' } });
    for (const res of [again, unknown, foreign]) {
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: DOWNLOAD_TOKEN_REFUSAL });
    }
    expect(DOWNLOAD_TOKEN_REFUSAL).toContain('request_file_download');
    // The issuer's own credential is no obstacle — and a refused foreign fetch did not spend the link.
    const own = await fetchLink(h.base, second!.downloadUrl, { headers: { authorization: `Bearer ${ANA.id}` } });
    expect(own.status).toBe(200);
  });

  it('takes the token in an x-download-token header on the address without its last segment', async () => {
    const h = await start();
    const { body } = await request(h.base, [`${KB}/Shared/Open.md`]);
    const url = local(h.base, body.files[0]!.downloadUrl);
    const token = decodeURIComponent(url.slice(url.lastIndexOf('/') + 1));

    const res = await fetch(`${h.base}/api/agent/downloads`, { headers: { 'x-download-token': token } });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('# open\n');
    expect((await fetch(url)).status).toBe(404);
    expect((await fetch(`${h.base}/api/agent/downloads`)).status).toBe(404);
  });

  it('does not spend a link on a HEAD probe', async () => {
    const h = await start();
    const { body } = await request(h.base, [`${KB}/Shared/Open.md`]);
    const url = body.files[0]!.downloadUrl;

    expect((await fetchLink(h.base, url, { method: 'HEAD' })).status).toBe(405);
    const res = await fetchLink(h.base, url);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('# open\n');
  });

  it('refuses an expired link the same way, and the sweep deletes bytes nobody fetched', async () => {
    const h = await start({ ttlMs: 50 });
    const { body } = await request(h.base, [`${KB}/Shared`]);
    expect((await readdir(h.downloadsRoot)).length).toBe(1);
    await new Promise((r) => setTimeout(r, 80));

    const res = await fetchLink(h.base, body.files[0]!.downloadUrl);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: DOWNLOAD_TOKEN_REFUSAL });
    await h.store.sweepNow();
    expect(await readdir(h.downloadsRoot)).toEqual([]);
    h.store.stopSweeping();
  });

  it('deletes the bytes of a request once every link of it has been fetched', async () => {
    const h = await start();
    const { body } = await request(h.base, [`${KB}/Shared`]);
    for (const url of [...body.files.map((f) => f.downloadUrl), body.folders[0]!.downloadUrl]) {
      await (await fetchLink(h.base, url)).arrayBuffer();
    }
    // `finish` runs as the response closes; give the event loop a turn.
    await new Promise((r) => setTimeout(r, 20));
    expect(await readdir(h.downloadsRoot)).toEqual([]);
    expect(h.store.openRequestsOf(ANA.id)).toBe(0);
    h.store.stopSweeping();
  });
});

describe('limits', () => {
  it('refuses the whole request over 500 MB, naming the total and the limit, before reading a byte', async () => {
    const h = await start();
    // Sparse: 501 MB on paper, nothing on disk — the refusal is decided by size alone.
    await truncate(join(h.repo, 'Pictures/logo.png'), 501 * 1024 * 1024);
    const { status, body } = await request(h.base, [`${KB}/Pictures/logo.png`, `${KB}/Shared/Open.md`]);

    expect(status).toBe(413);
    const total = 501 * 1024 * 1024 + '# open\n'.length;
    expect(body.error).toContain(`${total} bytes`);
    expect(body.error).toContain(`${500 * 1024 * 1024} byte download limit`);
    expect(await readdir(h.downloadsRoot)).toEqual([]);
  });

  it('checks the size before any file is read', async () => {
    const readFile = vi.fn(async () => Buffer.from('x'));
    await expect(
      buildDownload([`${KB}/a.md`, `${KB}/b.md`], {
        kbDirName: KB,
        maxBytes: 10,
        candidatesAt: async (p) => ({ kind: 'file', files: [{ path: p.slice(KB.length + 1), bytes: 6 }] }),
        canReadBatch: async (ps) => new Map(ps.map((p) => [p, true])),
        canDownloadBatch: async (ps) => new Map(ps.map((p) => [p, true])),
        notifyRead: async () => undefined,
        readFile,
        contentTypeOf: () => 'text/markdown',
      }),
    ).rejects.toMatchObject({ status: 413, details: { totalBytes: 12, maxBytes: 10 } });
    expect(readFile).not.toHaveBeenCalled();
  });

  it('holds a user to 10 open download requests, however many links each carries', async () => {
    const h = await start();
    const answers: Answer[] = [];
    for (let i = 0; i < 10; i++) {
      const ok = await request(h.base, [`${KB}/Shared`]);
      expect(ok.status).toBe(200);
      answers.push(ok.body);
    }
    const over = await request(h.base, [`${KB}/Shared/Open.md`]);
    expect(over.status).toBe(429);
    expect(over.body.error).toContain('10 open download requests');
    // A request whose links have all been fetched is no longer open.
    const first = answers[0]!;
    for (const url of [...first.files.map((f) => f.downloadUrl), first.folders[0]!.downloadUrl]) {
      await (await fetchLink(h.base, url)).arrayBuffer();
    }
    await new Promise((r) => setTimeout(r, 20));
    expect((await request(h.base, [`${KB}/Shared/Open.md`])).status).toBe(200);
    h.store.stopSweeping();
  });
});

describe('credentials, deployments and the read hook', () => {
  it('refuses a read-only credential before anything is built', async () => {
    const h = await start({ scope: 'read' });
    const { status } = await request(h.base, [`${KB}/Shared/Open.md`]);
    expect(status).toBe(403);
    expect(await readdir(h.downloadsRoot)).toEqual([]);
    expect(h.readsHooked).toEqual([]);
  });

  it('still serves a download on a read-only deployment: it is a read', async () => {
    const readOnly: IWriteAccess = { canWrite: async () => ({ ok: false, message: 'This deployment is read-only.' }) };
    const h = await start({ writeAccess: readOnly });
    const { status, body } = await request(h.base, [`${KB}/Shared/Open.md`]);
    expect(status).toBe(200);
    expect(body.code).not.toBe(READ_ONLY_CODE);
    expect(body.files).toHaveLength(1);
  });

  it('takes every included file to the read hook once, and lists a path the hook refuses', async () => {
    const h = await start({ hookRefuses: (p) => p.endsWith('/access.md') });
    const { status, body } = await request(h.base, [`${KB}/Shared`, `${KB}/Shared/Open.md`]);

    expect(status).toBe(200);
    // Only what passed the access rules reaches the hook, each path once.
    expect([...h.readsHooked].sort()).toEqual([`${KB}/Shared/Open.md`, `${KB}/Shared/access.md`]);
    expect(body.files.map((f) => f.path)).toEqual([`${KB}/Shared/Open.md`]);
    expect(body.refused).toContainEqual({
      path: `${KB}/Shared/access.md`,
      reason: `This session may not read ${KB}/Shared/access.md.`,
    });
    expect(body.folders[0]!.files).toEqual([`${KB}/Shared/Open.md`]);
  });
});

describe('what agents are told', () => {
  it('describes download beside upload in the shared rule on large and binary content', () => {
    const rule = sharedFileRules(DEFAULT_KB_LAYOUT).find((r) => r.id === 'upload-route')!;
    expect(rule.heading).toMatch(/download out/);
    expect(rule.body).toContain('`request_file_upload`');
    expect(rule.body).toContain('`request_file_download`');
    expect(rule.body).toContain('one-time link');
  });

  it('mounts the tool with a description that names the links, the refusals and the way back up', async () => {
    const registry = new ToolRegistry();
    registerWorkspaceTools(
      registry,
      express.Router(),
      (_q, _s, n) => n(),
      createToolHandlerFactory(async () => ({}) as never),
      {} as never,
      {} as never,
      {} as never,
      testKbContext({ kbDirName: KB }),
      { recoveryBotEmail: 'r@x', hooks: new WorkflowHooks(), notes: new ToolDescriptionNotes() },
      new RoutineWritePolicyService(),
      {} as never,
      undefined,
      undefined,
      undefined,
      undefined,
      new AgentDownloadStore({ root: tmpdir(), publicBaseUrl: PUBLIC_BASE }),
    );
    const def = (await registry.listExternal()).find((t) => t.name === 'request_file_download');
    expect(def).toBeDefined();
    for (const phrase of ['`request_file_upload`', '`apply_file_upload`', 'x-download-token', 'not found', 'download permission required', '500 MB', 'ONCE']) {
      expect(def!.description, phrase).toContain(phrase);
    }
  });
});
