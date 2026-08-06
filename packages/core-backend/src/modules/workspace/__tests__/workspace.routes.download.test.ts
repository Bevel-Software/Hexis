import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { describe, it, expect, afterEach, vi } from 'vitest';
import type { IWorkflowService } from '@bevel-software/platform-shared';
import type { IAccessControl } from '../../access/access-control.interface.js';
import type { WorkflowEventBus } from '../../workflow/event-bus.js';
import type { AuthService } from '../../auth/auth.service.js';
import { AccessConfigError } from '../../access/access-errors.js';
import type { IAdminAccessService } from '../../admin/admin.interface.js';
import { createWorkspaceRoutes } from '../workspace.routes.js';
import type { ICreatorAccess } from '../../access/creator-access.js';
import { FolderTooLargeError, type WorkspaceService } from '../workspace.service.js';

const stubCreatorAccess: ICreatorAccess = {
  planForCreate: async () => null,
  grantInExtractedFile: async () => null,
  noteAccessFileWritten: () => {},
};

/**
 * Contract test for the `?download=1` flavours of the workspace routes:
 *
 *   - GET /workspace/:id/file/raw?download=1  (single-file save)
 *   - GET /workspace/:id/folder/zip?download=1  (folder → zip save)
 *
 * Both are gated on the dedicated `Download` role in roles.yaml. Admin
 * status is fully orthogonal — being in the `Admin` role does NOT
 * implicitly grant Download; users must be listed under the `Download`
 * role to receive bytes. The inline branch of /file/raw (no flag) stays
 * open to every authenticated user so the PdfRenderer and image renderers
 * keep working for everyone.
 */

const USER_ID = 'user-1';
const USER = { id: USER_ID, email: 'alice@example.com', name: 'Alice' };
const WORKSPACE_ID = 'target-company-state';
const FILE_BYTES = Buffer.from('hello world');
const ZIP_BYTES = Buffer.from('PK\x03\x04 fake-zip-bytes');

interface Harness {
  server: Server;
  baseUrl: string;
  canDownload: ReturnType<typeof vi.fn>;
  canWrite: ReturnType<typeof vi.fn>;
  createFolderZip: ReturnType<typeof vi.fn>;
}

async function makeHarness(opts: {
  canDownload: boolean;
  folderZip?: () => Promise<Buffer> | Buffer;
  /** When set, canDownload rejects with this error instead of returning a bool. */
  canDownloadError?: Error;
}): Promise<Harness> {
  const canDownload = vi.fn(async () => {
    if (opts.canDownloadError) throw opts.canDownloadError;
    return opts.canDownload;
  });
  const canWrite = vi.fn();
  const accessControl: IAccessControl = {
    canWrite,
    canWriteBatch: vi.fn(),
    // The /file/raw route now read-gates before the download gate; these tests
    // exercise the download verb, so reads pass.
    canRead: vi.fn(async () => true),
    canReadBatch: vi.fn(async (_w: string, _e: string, paths: string[]) => new Map(paths.map((p) => [p, true]))),
    canDownload,
    eligibleWriters: vi.fn(),
    eligibleWriterEmails: vi.fn(),
    invalidate: vi.fn(),
    findEmailByHash: vi.fn(),
    canWriteAtRef: vi.fn(),
    canWriteBatchAtRef: vi.fn(),
    eligibleWritersAtRef: vi.fn(),
    eligibleWritersForPathsAtRef: vi.fn(),
  } as unknown as IAccessControl;

  const createFolderZip = vi.fn(async () => {
    if (opts.folderZip) return opts.folderZip();
    return ZIP_BYTES;
  });

  // Partial<WorkspaceService> + final cast keeps the contract typed at the
  // call site (createWorkspaceRoutes wants a full WorkspaceService) while
  // letting us stub only the two methods these tests exercise.
  const workspaceServiceMock: Partial<WorkspaceService> = {
    readFileBinary: vi.fn(async () => FILE_BYTES),
    createFolderZip,
  };
  const workspaceService = workspaceServiceMock as WorkspaceService;

  const authServiceMock: Partial<AuthService> = {
    getUserById: vi.fn(async () => USER),
  };
  const authService = authServiceMock as AuthService;

  const workflowService = {} as unknown as IWorkflowService;
  const eventBus = {} as unknown as WorkflowEventBus;

  const app = express();
  app.use(express.json());
  app.use('/api', (req, _res, next) => {
    (req as any).userId = USER_ID;
    next();
  });
  app.use('/api', createWorkspaceRoutes(
    workspaceService,
    authService,
    workflowService,
    eventBus,
    accessControl,
    'knowledge-base',
    stubCreatorAccess,
    // Not exercised here — only `.bevelignore`'s tree visibility consults it.
    { isAdmin: async () => false } as unknown as IAdminAccessService,
  ));

  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  // `server.address()` returns `AddressInfo | string | null`. The string
  // branch is for Unix-domain sockets and the null branch for an
  // unbound listener — neither can happen here (we awaited `listen(0,
  // ...)` on a TCP port), so a narrow + throw is sufficient and avoids
  // the `as any` lint.
  const addr = server.address();
  if (addr === null || typeof addr === 'string') {
    throw new Error(`Unexpected server.address() shape: ${JSON.stringify(addr)}`);
  }
  const port = (addr as AddressInfo).port;
  return { server, baseUrl: `http://127.0.0.1:${port}`, canDownload, canWrite, createFolderZip };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
}

describe('GET /workspace/:id/file/raw — ?download=1 gated on Download role', () => {
  let h: Harness | null = null;
  afterEach(async () => { if (h) await closeServer(h.server); h = null; });

  it('user with Download role gets 200 + attachment disposition + bytes', async () => {
    h = await makeHarness({ canDownload: true });
    const res = await fetch(
      `${h.baseUrl}/api/workspace/${WORKSPACE_ID}/file/raw?path=${encodeURIComponent('Knowledge/Foo.md')}&download=1`,
    );
    expect(res.status).toBe(200);
    const dispo = res.headers.get('content-disposition');
    expect(dispo).toBeTruthy();
    expect(dispo).toContain('attachment');
    expect(dispo).toContain(`filename*=UTF-8''${encodeURIComponent('Foo.md')}`);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.equals(FILE_BYTES)).toBe(true);
    // canDownload is path-scoped now; the route strips the kbDirName prefix
    // before consulting the access service (mirrors useFileAccess on the
    // frontend), so the resolver sees the repo-relative path.
    expect(h.canDownload).toHaveBeenCalledWith(WORKSPACE_ID, USER.email, 'Knowledge/Foo.md');
    // canWrite must NOT be consulted by the download gate — the two verbs
    // are independent.
    expect(h.canWrite).not.toHaveBeenCalled();
  });

  it('user without Download role gets 403 with no body bytes', async () => {
    h = await makeHarness({ canDownload: false });
    const res = await fetch(
      `${h.baseUrl}/api/workspace/${WORKSPACE_ID}/file/raw?path=${encodeURIComponent('Knowledge/Foo.md')}&download=1`,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Download permission required');
    expect(res.headers.get('content-disposition')).toBeNull();
  });

  it('inline view (no ?download flag) returns 200 for any authed user without consulting access-control', async () => {
    // Even a user with no download permission must be able to view PDFs /
    // images inline — that's the PdfRenderer happy path. The route must not
    // call canDownload at all on this branch.
    h = await makeHarness({ canDownload: false });
    const res = await fetch(
      `${h.baseUrl}/api/workspace/${WORKSPACE_ID}/file/raw?path=${encodeURIComponent('Knowledge/Foo.md')}`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBeNull();
    expect(h.canDownload).not.toHaveBeenCalled();
  });

  it('returns 500 with AccessConfigError payload when roles.yaml / access.md fails to load', async () => {
    // Regression guard: if `canDownload` throws inside requireDownloadPermission
    // (e.g. roles.yaml is missing or the access tree is unrecoverably
    // malformed) and we don't catch it, the async rejection bubbles past
    // Express and the request hangs (or 500s without the helpful
    // config-error payload). The route should surface the
    // WorkflowDomainError shape — same JSON the per-path /access endpoint
    // returns when it hits the same exception — so the operator can see
    // which access.md file is broken.
    const configErr = new AccessConfigError([
      "Knowledge/Sales/access.md: unknown role 'Product Manager'",
    ]);
    h = await makeHarness({ canDownload: true, canDownloadError: configErr });
    const res = await fetch(
      `${h.baseUrl}/api/workspace/${WORKSPACE_ID}/file/raw?path=${encodeURIComponent('Knowledge/Foo.md')}&download=1`,
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; accessConfigErrors?: string[] };
    expect(body.error).toContain('Access-control config is invalid');
    expect(body.accessConfigErrors?.[0]).toContain("unknown role 'Product Manager'");
  });

  it('forces SVG to octet-stream when downloading (anti-XSS), preserves image/svg+xml inline', async () => {
    h = await makeHarness({ canDownload: true });
    const dl = await fetch(
      `${h.baseUrl}/api/workspace/${WORKSPACE_ID}/file/raw?path=${encodeURIComponent('icon.svg')}&download=1`,
    );
    expect(dl.headers.get('content-type')).toBe('application/octet-stream');

    await closeServer(h.server);
    h = await makeHarness({ canDownload: false });
    const inline = await fetch(
      `${h.baseUrl}/api/workspace/${WORKSPACE_ID}/file/raw?path=${encodeURIComponent('icon.svg')}`,
    );
    expect(inline.headers.get('content-type')).toBe('image/svg+xml');
    // Inline keeps the real type so the image renderer's blob still paints,
    // and is sandboxed so the same URL opened as a tab cannot run its own
    // <script> against this origin.
    expect(inline.headers.get('content-security-policy')).toBe('sandbox');
  });

  // Everything else served inline is passive, and a blanket sandbox on, say, a
  // PDF would cost the viewer its own controls for nothing.
  it('sandboxes only SVG — other inline files carry no CSP', async () => {
    h = await makeHarness({ canDownload: true });
    const res = await fetch(
      `${h.baseUrl}/api/workspace/${WORKSPACE_ID}/file/raw?path=${encodeURIComponent('Knowledge/Foo.md')}`,
    );
    expect(res.headers.get('content-security-policy')).toBeNull();
  });
});

describe('GET /workspace/:id/folder/zip — gated on Download role', () => {
  let h: Harness | null = null;
  afterEach(async () => { if (h) await closeServer(h.server); h = null; });

  it('user with Download role gets a 200 zip with attachment disposition', async () => {
    h = await makeHarness({ canDownload: true });
    const res = await fetch(
      `${h.baseUrl}/api/workspace/${WORKSPACE_ID}/folder/zip?path=${encodeURIComponent('Knowledge/Sales')}&download=1`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const dispo = res.headers.get('content-disposition');
    expect(dispo).toBeTruthy();
    expect(dispo).toContain('attachment');
    expect(dispo).toContain(`filename*=UTF-8''${encodeURIComponent('Sales.zip')}`);
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.equals(ZIP_BYTES)).toBe(true);
    expect(h.canDownload).toHaveBeenCalledWith(WORKSPACE_ID, USER.email, 'Knowledge/Sales');
    expect(h.createFolderZip).toHaveBeenCalledWith(WORKSPACE_ID, 'Knowledge/Sales');
  });

  it('user without Download role gets 403 and no zip is built', async () => {
    h = await makeHarness({ canDownload: false });
    const res = await fetch(
      `${h.baseUrl}/api/workspace/${WORKSPACE_ID}/folder/zip?path=${encodeURIComponent('Knowledge/Sales')}&download=1`,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Download permission required');
    expect(h.createFolderZip).not.toHaveBeenCalled();
  });

  it('requires ?download=1 — a stray inline call is rejected with 400', async () => {
    // Folder zip is download-only; refuse the inline shape so the URL contract
    // matches the file route and there's no ambiguity about what should happen.
    h = await makeHarness({ canDownload: true });
    const res = await fetch(
      `${h.baseUrl}/api/workspace/${WORKSPACE_ID}/folder/zip?path=${encodeURIComponent('Knowledge/Sales')}`,
    );
    expect(res.status).toBe(400);
    expect(h.createFolderZip).not.toHaveBeenCalled();
  });

  it('maps FolderTooLargeError to 413 with the limit-bearing message', async () => {
    h = await makeHarness({
      canDownload: true,
      folderZip: async () => { throw new FolderTooLargeError(500 * 1024 * 1024); },
    });
    const res = await fetch(
      `${h.baseUrl}/api/workspace/${WORKSPACE_ID}/folder/zip?path=${encodeURIComponent('Big')}&download=1`,
    );
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('524288000');
  });

  it('maps Path traversal detected to 403', async () => {
    h = await makeHarness({
      canDownload: true,
      folderZip: async () => { throw new Error('Path traversal detected'); },
    });
    const res = await fetch(
      `${h.baseUrl}/api/workspace/${WORKSPACE_ID}/folder/zip?path=${encodeURIComponent('../escape')}&download=1`,
    );
    expect(res.status).toBe(403);
  });

  it('maps Not a directory to 400 (user pointed at a file)', async () => {
    h = await makeHarness({
      canDownload: true,
      folderZip: async () => { throw new Error('Not a directory'); },
    });
    const res = await fetch(
      `${h.baseUrl}/api/workspace/${WORKSPACE_ID}/folder/zip?path=${encodeURIComponent('Knowledge/Foo.md')}&download=1`,
    );
    expect(res.status).toBe(400);
  });
});
