import { get as httpGet, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { describe, it, expect, afterEach, vi } from 'vitest';
import type { IWorkflowService } from '@bevel-software/platform-shared';
import { testKbContext } from '../../../__tests__/kb-context.js';
import { NodeFs } from '../../kb-fs/node-fs.js';
import { VersionNotOnBranchError, VERSION_NOT_ON_BRANCH_MESSAGE } from '../../../shared/domain-errors.js';
import type { IAccessControl } from '../../access/access-control.interface.js';
import type { ICreatorAccess } from '../../access-model/creator.js';
import type { IAdminAccessService } from '../../admin/admin.interface.js';
import type { WorkflowEventBus } from '../../workflow/event-bus.js';
import type { AuthService } from '../../auth/auth.service.js';
import { createWorkspaceRoutes } from '../workspace.routes.js';
import type { WorkspaceService } from '../workspace.service.js';

/**
 * `GET /workspace/:id/file/raw?ref=<sha>` — the bytes of a PAST save.
 *
 * What the suite is really pinning is that the ref changes WHICH bytes and
 * nothing else about the route: the same read gate, the same `download:` verb,
 * the same content type and svg sandbox, and — the one that would be worst to
 * get wrong — that a request naming a ref can never come back with today's
 * working-tree bytes. A silent fall back there looks exactly like a success.
 */

const USER_ID = 'user-1';
const USER = { id: USER_ID, email: 'alice@example.com', name: 'Alice' };
const WS = 'target-company-state';
const KB = 'knowledge-base';
const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

/** Bytes that are not valid UTF-8, so a decode step anywhere would be visible. */
const PAST_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x01]);
const TREE_BYTES = Buffer.from('TODAY');

const stubCreatorAccess: ICreatorAccess = {
  planForCreate: async () => null,
  grantInExtractedFile: async () => null,
  noteAccessFileWritten: () => {},
};

interface Harness {
  server: Server;
  baseUrl: string;
  fileBytesAtChange: ReturnType<typeof vi.fn>;
  readFileBinary: ReturnType<typeof vi.fn>;
  canDownload: ReturnType<typeof vi.fn>;
}

async function makeHarness(
  opts: {
    canRead?: boolean;
    canDownload?: boolean;
    /** What the workflow service answers; default is the past bytes. */
    atRef?: () => Promise<{ bytes: Uint8Array; blobId: string } | null>;
  } = {},
): Promise<Harness> {
  const canRead = vi.fn(async () => opts.canRead !== false);
  const canDownload = vi.fn(async () => opts.canDownload !== false);
  const accessControl = {
    canRead,
    canDownload,
    canReadBatch: vi.fn(async (_w: string, _e: string, paths: string[]) =>
      new Map(paths.map((p) => [p, opts.canRead !== false])),
    ),
  } as unknown as IAccessControl;

  const readFileBinary = vi.fn(async () => TREE_BYTES);
  const workspaceService = { readFileBinary } as unknown as WorkspaceService;

  const fileBytesAtChange = vi.fn(
    opts.atRef ?? (async () => ({ bytes: PAST_BYTES, blobId: 'deadbeef'.repeat(5) })),
  );
  const workflowService = { fileBytesAtChange } as unknown as IWorkflowService;

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
      workflowService,
      {} as unknown as WorkflowEventBus,
      accessControl,
      testKbContext({ kbDirName: KB }),
      stubCreatorAccess,
      { isAdmin: async () => false } as unknown as IAdminAccessService,
      new NodeFs(),
    ),
  );
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address() as AddressInfo;
  return {
    server,
    baseUrl: `http://127.0.0.1:${addr.port}`,
    fileBytesAtChange,
    readFileBinary,
    canDownload,
  };
}

function close(s: Server): Promise<void> {
  return new Promise((resolve, reject) => s.close((e) => (e ? reject(e) : resolve())));
}

describe('GET /workspace/:id/file/raw?ref= — one file at a past save', () => {
  let h: Harness | null = null;
  afterEach(async () => {
    if (h) await close(h.server);
    h = null;
  });

  const raw = (query: string) => fetch(`${h!.baseUrl}/api/workspace/${WS}/file/raw?${query}`);
  const png = (extra = '') =>
    `path=${encodeURIComponent(`${KB}/Docs/logo.png`)}&ref=${SHA}${extra}`;

  it('serves the save\'s exact bytes with the format\'s content type, and never the working tree', async () => {
    h = await makeHarness();
    const res = await raw(png());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('private, no-cache');
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(PAST_BYTES)).toBe(true);
    // THE regression guard: a ref read must not reach the working tree at all.
    expect(h.readFileBinary).not.toHaveBeenCalled();
    expect(h.fileBytesAtChange).toHaveBeenCalledWith(WS, `${KB}/Docs/logo.png`, SHA, 'after');
  });

  it('reads the side just before the save when asked, for a save that deleted the file', async () => {
    h = await makeHarness();
    const res = await raw(png('&side=before'));
    expect(res.status).toBe(200);
    expect(h.fileBytesAtChange).toHaveBeenCalledWith(WS, `${KB}/Docs/logo.png`, SHA, 'before');
  });

  it('answers 400 for a malformed ref, and never falls back to today\'s bytes', async () => {
    h = await makeHarness();
    for (const bad of ['HEAD', 'main', 'zzz', `${SHA}${SHA}`, 'abc']) {
      const res = await raw(`path=${encodeURIComponent(`${KB}/Docs/logo.png`)}&ref=${bad}`);
      expect(res.status).toBe(400);
    }
    expect(h.readFileBinary).not.toHaveBeenCalled();
    expect(h.fileBytesAtChange).not.toHaveBeenCalled();
  });

  it('answers 400 for an unknown side, and for a side with no ref', async () => {
    h = await makeHarness();
    expect((await raw(png('&side=middle'))).status).toBe(400);
    const orphan = await raw(`path=${encodeURIComponent(`${KB}/Docs/logo.png`)}&side=before`);
    expect(orphan.status).toBe(400);
    expect(h.readFileBinary).not.toHaveBeenCalled();
  });

  it('answers 404 with the history message for a save off this branch', async () => {
    h = await makeHarness({
      atRef: async () => {
        throw new VersionNotOnBranchError();
      },
    });
    const res = await raw(png());
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe(VERSION_NOT_ON_BRANCH_MESSAGE);
  });

  it('answers 404 when the file was not there on that side', async () => {
    h = await makeHarness({ atRef: async () => null });
    const res = await raw(png());
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe('File not found');
  });

  it('answers a failure of OUR making with a 500, not "File not found"', async () => {
    // The ref read goes through the git runner: a blob over its output ceiling
    // arrives here as a RangeError, a hung `cat-file` as a run error. Either
    // one answered 404 would tell a reader the save they can SEE LISTED had
    // vanished — and would retire the pane's "Try again" as pointless.
    h = await makeHarness({
      atRef: async () => {
        throw new RangeError('git output exceeded 67108864 bytes');
      },
    });
    const res = await raw(png());
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toBe(
      'Could not read this version of the file',
    );
  });

  it('refuses a reader who may not read the file today, before any read happens', async () => {
    h = await makeHarness({ canRead: false });
    const res = await raw(png());
    expect(res.status).toBe(403);
    expect(h.fileBytesAtChange).not.toHaveBeenCalled();
  });

  it('refuses a download without the download verb, and allows the inline read', async () => {
    h = await makeHarness({ canDownload: false });
    const dl = await raw(png('&download=1'));
    expect(dl.status).toBe(403);
    expect(((await dl.json()) as { error: string }).error).toBe('Download permission required');
    expect(h.fileBytesAtChange).not.toHaveBeenCalled();

    // The same reader still SEES the version — read and download are separate
    // verbs at a ref exactly as they are in the working tree.
    const inline = await raw(png());
    expect(inline.status).toBe(200);
  });

  it('downloads the VERSION bytes, named in the attachment disposition', async () => {
    h = await makeHarness();
    const res = await raw(png('&download=1'));
    expect(res.status).toBe(200);
    // The bytes, not just the headers: a download that quietly fell back to
    // the working tree would hand over today's file under a past save's name,
    // and every header assertion would still pass.
    expect(Buffer.from(await res.arrayBuffer()).equals(PAST_BYTES)).toBe(true);
    expect(h.fileBytesAtChange).toHaveBeenCalledWith(WS, `${KB}/Docs/logo.png`, SHA, 'after');
    expect(h.readFileBinary).not.toHaveBeenCalled();
    expect(res.headers.get('content-disposition')).toContain(
      `filename*=UTF-8''${encodeURIComponent('logo.png')}`,
    );
  });

  it('keeps the svg rules at a ref: sandboxed inline, octet-stream on download', async () => {
    h = await makeHarness();
    const path = `path=${encodeURIComponent(`${KB}/Docs/chart.svg`)}&ref=${SHA}`;
    const inline = await raw(path);
    expect(inline.headers.get('content-type')).toBe('image/svg+xml');
    expect(inline.headers.get('content-security-policy')).toBe('sandbox');
    const dl = await raw(`${path}&download=1`);
    expect(dl.headers.get('content-type')).toBe('application/octet-stream');
  });

  it('ETags the version by its blob id and answers a revalidation with 304', async () => {
    h = await makeHarness();
    const first = await raw(png());
    const etag = first.headers.get('etag');
    expect(etag).toBe(`"${'deadbeef'.repeat(5)}"`);

    // `node:http` rather than fetch: undici adds `Cache-Control: no-cache` to
    // a conditional request, which Express reads as "do not answer 304".
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpGet(
        `${h!.baseUrl}/api/workspace/${WS}/file/raw?${png()}`,
        { headers: { 'If-None-Match': etag! } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
    });
    expect(status).toBe(304);
  });

  it('is unchanged for a request with no ref: the working tree, as before', async () => {
    h = await makeHarness();
    const res = await raw(`path=${encodeURIComponent(`${KB}/Docs/logo.png`)}`);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(TREE_BYTES)).toBe(true);
    expect(h.fileBytesAtChange).not.toHaveBeenCalled();
  });
});
