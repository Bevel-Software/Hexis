import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { describe, it, expect, afterEach, vi } from 'vitest';
import type { IWorkflowService } from '@bevel-software/platform-shared';
import type { IAccessControl } from '../../access/access-control.interface.js';
import type { ICreatorAccess } from '../../access/creator-access.js';
import type { IAdminAccessService } from '../../admin/admin.interface.js';
import type { WorkflowEventBus } from '../../workflow/event-bus.js';
import type { AuthService } from '../../auth/auth.service.js';
import { createWorkspaceRoutes } from '../workspace.routes.js';
import type { WorkspaceService, ReadTreeFilter } from '../workspace.service.js';

/**
 * Contract test for the read-permission gates on the human read routes:
 *   GET /file, /file/raw (inline), /resolve-id, /kb-files, /files.
 * `allow(path)` decides each verdict; by convention any path containing
 * "Secret" is denied. The harness wires the real route layer over mocked
 * access + workspace services. (The /graph + /resolve-id routes live in the
 * enterprise kb-graph module; their gate tests moved with them.)
 */

const USER_ID = 'user-1';
const USER = { id: USER_ID, email: 'alice@example.com', name: 'Alice' };
const WS = 'target-company-state';
const KB = 'knowledge-base';

const allow = (p: string) => !p.includes('Secret');

const stubCreatorAccess: ICreatorAccess = {
  planForCreate: async () => null,
  grantInExtractedFile: async () => null,
  noteAccessFileWritten: () => {},
};


interface Harness {
  server: Server;
  baseUrl: string;
  canRead: ReturnType<typeof vi.fn>;
  canReadBatchFull: ReturnType<typeof vi.fn>;
  listFilesFilter: () => ReadTreeFilter | undefined;
}

async function makeHarness(opts: {
  kbFiles?: Record<string, string>;
  allowFn?: (p: string) => boolean;
  /** Whether the caller is an admin — only `.bevelignore`'s visibility uses it. */
  isAdmin?: boolean;
} = {}): Promise<Harness> {
  const allowP = opts.allowFn ?? allow;
  const canRead = vi.fn(async (_w: string, _e: string, p: string) => allowP(p));
  const batch = async (_w: string, _e: string, paths: string[]) =>
    new Map(paths.map((p) => [p, allowP(p)]));
  const canReadBatchFull = vi.fn(batch);
  const accessControl = {
    canRead,
    canReadBatch: canReadBatchFull,
  } as unknown as IAccessControl;

  let captured: ReadTreeFilter | undefined;
  const workspaceService = {
    getOrCreateForBranch: vi.fn(async (branch: string) => ({
      id: branch,
      name: branch,
      absolutePath: `/tmp/${branch}`,
      createdAt: new Date(0).toISOString(),
      kbDirName: KB,
    })),
    readFile: vi.fn(async () => 'CONTENT'),
    readFileBinary: vi.fn(async () => Buffer.from('BYTES')),
    readAllKbFiles: vi.fn(async () => opts.kbFiles ?? {}),
    listFiles: vi.fn(async (_id: string, filter?: ReadTreeFilter) => {
      captured = filter;
      return { name: 'root', relativePath: '.', type: 'directory', children: [] };
    }),
  } as unknown as WorkspaceService;

  const authService = { getUserById: vi.fn(async () => USER) } as unknown as AuthService;

  const app = express();
  app.use(express.json());
  app.use('/api', (req, _res, next) => {
    (req as unknown as { userId: string }).userId = USER_ID;
    next();
  });
  app.use(
    '/api',
    createWorkspaceRoutes(
      workspaceService,
      authService,
      {} as unknown as IWorkflowService,
      {} as unknown as WorkflowEventBus,
      accessControl,
      KB,
      stubCreatorAccess,
      { isAdmin: async () => opts.isAdmin === true } as unknown as IAdminAccessService,
    ),
  );
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address() as AddressInfo;
  return {
    server,
    baseUrl: `http://127.0.0.1:${addr.port}`,
    canRead,
    canReadBatchFull,
    listFilesFilter: () => captured,
  };
}

function close(s: Server): Promise<void> {
  return new Promise((resolve, reject) => s.close((e) => (e ? reject(e) : resolve())));
}

describe('read-permission gates on human read routes', () => {
  let h: Harness | null = null;
  afterEach(async () => { if (h) await close(h.server); h = null; });

  const get = (path: string) => fetch(`${h!.baseUrl}/api/workspace/${WS}${path}`);

  it('GET /file: readable → 200, denied → 403', async () => {
    h = await makeHarness();
    // Paths are workspace-relative (kbDir-prefixed), as the file tree produces
    // and `readFile` resolves them.
    const ok = await get(`/file?path=${encodeURIComponent(`${KB}/Knowledge/Open/a.md`)}`);
    expect(ok.status).toBe(200);
    expect((await ok.json()).content).toBe('CONTENT');

    const denied = await get(`/file?path=${encodeURIComponent(`${KB}/Knowledge/Secret/x.md`)}`);
    expect(denied.status).toBe(403);
    // canRead consulted with the KB-repo-relative path (kbDir prefix stripped).
    expect(h.canRead).toHaveBeenCalledWith(WS, USER.email, 'Knowledge/Secret/x.md');
  });

  it('GET /file: a non-KB path (reserved workspace file) is not read-gated', async () => {
    h = await makeHarness();
    // Outside `kbDirName` → carries no read rules → served without a canRead
    // check (matches the agent tools and diff routes). Previously this 403'd
    // because the full path was passed to default-deny canRead.
    const res = await get(`/file?path=${encodeURIComponent('reserved-config.json')}`);
    expect(res.status).toBe(200);
    expect(h.canRead).not.toHaveBeenCalled();
  });

  it('GET /file/raw (inline, no download) is read-gated', async () => {
    h = await makeHarness();
    const denied = await get(`/file/raw?path=${encodeURIComponent(`${KB}/Secret/x.png`)}`);
    expect(denied.status).toBe(403);
    const ok = await get(`/file/raw?path=${encodeURIComponent(`${KB}/Open/a.png`)}`);
    expect(ok.status).toBe(200);
  });

  // NOTE (core split): the `GET /resolve-id` and `GET /graph` read-gate tests
  // moved with the kb-graph module (enterprise) — those routes are not part of
  // the core workspace surface.

  it('GET /kb-files drops unreadable nodes from the graph payload', async () => {
    h = await makeHarness({ kbFiles: { 'Knowledge/Open/a.md': 'A', 'Knowledge/Secret/x.md': 'S' } });
    const res = await get('/kb-files');
    expect(res.status).toBe(200);
    const { files } = await res.json();
    expect(files['Knowledge/Open/a.md']).toBe('A');
    expect(files['Knowledge/Secret/x.md']).toBeUndefined();
  });

  it('GET /files passes a working shallow read filter to listFiles', async () => {
    h = await makeHarness();
    expect((await get('/files')).status).toBe(200);
    const filter = h.listFilesFilter();
    expect(typeof filter).toBe('function');
    // The filter maps workspace-relative paths (kbDir-prefixed) → verdicts,
    // stripping the kbDir and consulting the full canReadBatch.
    const verdict = await filter!([
      `${KB}/Knowledge/Open/a.md`,
      `${KB}/Knowledge/Secret/x.md`,
    ]);
    expect(verdict.get(`${KB}/Knowledge/Open/a.md`)).toBe(true);
    expect(verdict.get(`${KB}/Knowledge/Secret/x.md`)).toBe(false);
  });

  it('keeps the structural root folders visible even when nothing is readable', async () => {
    // A user with no read grants: the access batch denies everything. The
    // structural top-level folders (KnowledgeBase, Data, Agents, Pipelines,
    // Plugins) must still resolve readable (so the explorer renders its
    // section view), while their contents stay gated. The retired Skills/
    // and Tools/ roots get NO structural treatment — they are ordinary
    // (denied) folders now.
    h = await makeHarness({ allowFn: () => false });
    expect((await get('/files')).status).toBe(200);
    const filter = h.listFilesFilter();
    const verdict = await filter!([
      `${KB}/KnowledgeBase`,
      `${KB}/Data`,
      `${KB}/Agents`,
      `${KB}/Pipelines`,
      `${KB}/Plugins`,
      `${KB}/Skills`,
      `${KB}/Tools`,
      `${KB}/KnowledgeBase/Open/a.md`,
      `${KB}/Data/Ops/Knowledge/item.md`,
      `${KB}/Plugins/GTM/rfi/SKILL.md`,
    ]);
    // Folders themselves: forced visible.
    expect(verdict.get(`${KB}/KnowledgeBase`)).toBe(true);
    expect(verdict.get(`${KB}/Data`)).toBe(true);
    expect(verdict.get(`${KB}/Agents`)).toBe(true);
    expect(verdict.get(`${KB}/Pipelines`)).toBe(true);
    expect(verdict.get(`${KB}/Plugins`)).toBe(true);
    // Retired roots: no override, the deny-all batch verdict stands.
    expect(verdict.get(`${KB}/Skills`)).toBe(false);
    expect(verdict.get(`${KB}/Tools`)).toBe(false);
    // Their contents: still gated (the override matches only the exact folder).
    expect(verdict.get(`${KB}/KnowledgeBase/Open/a.md`)).toBe(false);
    expect(verdict.get(`${KB}/Data/Ops/Knowledge/item.md`)).toBe(false);
    expect(verdict.get(`${KB}/Plugins/GTM/rfi/SKILL.md`)).toBe(false);
  });

  it('resolves every entry with the FULL read batch (frontmatter grants AND denies honoured)', async () => {
    // The tree filter consults the full canReadBatch for ALL paths in one
    // call — a per-file frontmatter grant (e.g. the creator read grant a
    // loose root-level .md gets on creation) makes the file visible, and a
    // frontmatter deny hides it, exactly matching what the content route
    // will enforce on open.
    h = await makeHarness({ allowFn: () => false });
    const full = h.canReadBatchFull;
    full.mockImplementation(async (_w: string, _e: string, paths: string[]) =>
      new Map(paths.map((p) => [p, p === 'KnowledgeBase/mine.md'])));
    expect((await get('/files')).status).toBe(200);
    const filter = h.listFilesFilter();
    const verdict = await filter!([
      `${KB}/KnowledgeBase/mine.md`, // frontmatter grant → visible
      `${KB}/KnowledgeBase/other.md`, // no grant → hidden
      `${KB}/KnowledgeBase/Secret/deep.md`, // no grant → hidden
    ]);
    expect(verdict.get(`${KB}/KnowledgeBase/mine.md`)).toBe(true);
    expect(verdict.get(`${KB}/KnowledgeBase/other.md`)).toBe(false);
    expect(verdict.get(`${KB}/KnowledgeBase/Secret/deep.md`)).toBe(false);
    // ONE batched call covers every path — no per-file fan-out.
    expect(full).toHaveBeenCalledTimes(1);
    expect(full.mock.calls[0][2]).toEqual([
      'KnowledgeBase/mine.md',
      'KnowledgeBase/other.md',
      'KnowledgeBase/Secret/deep.md',
    ]);
  });

  it('legacy layout: root-level Knowledge/ is forced visible and its loose files get the full check', async () => {
    // Clones that predate the KnowledgeBase/Skills split keep their knowledge
    // root at `Knowledge/` (repo root). It must get the same structural-root
    // treatment: the folder itself stays visible, and a loose file directly
    // under it (whose creator grant lives in frontmatter) is re-checked with
    // the FULL batch.
    h = await makeHarness({ allowFn: () => false });
    h.canReadBatchFull.mockImplementation(async (_w: string, _e: string, paths: string[]) =>
      new Map(paths.map((p) => [p, p === 'Knowledge/mine.md'])));
    expect((await get('/files')).status).toBe(200);
    const filter = h.listFilesFilter();
    const verdict = await filter!([
      `${KB}/Knowledge`,
      `${KB}/Knowledge/mine.md`,
      `${KB}/Knowledge/other.md`,
      `${KB}/Knowledge/Secret/deep.md`,
    ]);
    expect(verdict.get(`${KB}/Knowledge`)).toBe(true);
    expect(verdict.get(`${KB}/Knowledge/mine.md`)).toBe(true);
    expect(verdict.get(`${KB}/Knowledge/other.md`)).toBe(false);
    expect(verdict.get(`${KB}/Knowledge/Secret/deep.md`)).toBe(false);
  });

  it('GET /workspace bootstrap also returns a read-filtered file tree', async () => {
    h = await makeHarness();
    const res = await fetch(`${h.baseUrl}/api/workspace?branch=${encodeURIComponent(WS)}`);
    expect(res.status).toBe(200);
    const filter = h.listFilesFilter();
    expect(typeof filter).toBe('function');
    const verdict = await filter!([
      `${KB}/Knowledge/Open/a.md`,
      `${KB}/Knowledge/Secret/x.md`,
    ]);
    expect(verdict.get(`${KB}/Knowledge/Open/a.md`)).toBe(true);
    expect(verdict.get(`${KB}/Knowledge/Secret/x.md`)).toBe(false);
  });
});

/**
 * `.bevelignore` decides what the file tree and the agent view show at all, so
 * it is deployment configuration rather than knowledge. It also sits alone in
 * being visible — its siblings (`.gitignore`, `roles.yaml`, `access.md`,
 * `AGENTS.md`) are hidden from every reader by the shipped ignore rules.
 *
 * READ PERMISSION IS NOT THE LEVER, which is why this is a listing decision and
 * not an ACL one: everyone can read the file (it has to be readable to be
 * applied), so the tests below hold the read verdict at `true` throughout and
 * assert that admin-ness alone moves the outcome.
 */
describe('.bevelignore is admin-only in the file tree', () => {
  let h: Harness | null = null;
  afterEach(async () => { if (h) await close(h.server); h = null; });

  // The harness's default `allow` — none of the paths below contain "Secret",
  // so every one of them is READABLE. That is the point: the read verdict is
  // held constant and admin-ness alone moves the outcome.
  const treeFilter = async (isAdmin: boolean) => {
    h = await makeHarness({ isAdmin });
    await fetch(`${h.baseUrl}/api/workspace/${WS}/files`);
    return h.listFilesFilter()!;
  };

  it('hides it from a non-admin who can otherwise read everything', async () => {
    const verdict = await (await treeFilter(false))([
      `${KB}/.bevelignore`,
      `${KB}/Knowledge/Open/a.md`,
    ]);
    expect(verdict.get(`${KB}/.bevelignore`)).toBe(false);
    // Only that one file — the rest of the tree is untouched.
    expect(verdict.get(`${KB}/Knowledge/Open/a.md`)).toBe(true);
  });

  it('shows it to an admin', async () => {
    const verdict = await (await treeFilter(true))([`${KB}/.bevelignore`]);
    expect(verdict.get(`${KB}/.bevelignore`)).toBe(true);
  });

  /** The stack is hierarchical — a nested one governs its own subtree. */
  it('hides a nested one too, not just the repo-root file', async () => {
    const verdict = await (await treeFilter(false))([`${KB}/KnowledgeBase/Product/.bevelignore`]);
    expect(verdict.get(`${KB}/KnowledgeBase/Product/.bevelignore`)).toBe(false);
  });

  /** Basename match, not substring: a file merely NAMED after it stays visible. */
  it('does not hide files whose name only contains it', async () => {
    const verdict = await (await treeFilter(false))([`${KB}/Knowledge/.bevelignore.md`]);
    expect(verdict.get(`${KB}/Knowledge/.bevelignore.md`)).toBe(true);
  });
});
