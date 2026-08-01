import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { describe, it, expect, afterEach, vi } from 'vitest';
import type { FileTreeEntry } from '@bevel-software/platform-shared';

import type { IAccessControl } from '../access-control.interface.js';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import type { AuthService } from '../../auth/auth.service.js';
import type { WorkflowService } from '../../workflow/workflow.service.js';
import type { WorkflowEventBus } from '../../workflow/event-bus.js';
import type { Database } from '../../database/connection.js';
import { createAccessRoutes } from '../access.routes.js';

/**
 * HTTP contract for `GET /access/overrides`. The scan itself is covered in
 * `access-declarations.test.ts`; what is under test here is the DISCLOSURE
 * boundary — the folder-read gate, the per-row read filter, and the path
 * validation that stops a caller pointing the scan outside the KB.
 */

const USER = { id: 'u-1', email: 'alice@bevel.software', name: 'Alice' };
const WS = 'main';
const KB = 'knowledge-base';

function buildTree(paths: string[]): FileTreeEntry {
  const root: FileTreeEntry = { name: '', relativePath: '', type: 'directory', children: [] };
  for (const wsPath of paths) {
    const segments = wsPath.split('/');
    let node = root;
    segments.forEach((segment, i) => {
      const isLeaf = i === segments.length - 1;
      let child = node.children?.find((c) => c.name === segment);
      if (!child) {
        child = {
          name: segment,
          relativePath: segments.slice(0, i + 1).join('/'),
          type: isLeaf ? 'file' : 'directory',
          ...(isLeaf ? {} : { children: [] }),
        };
        node.children?.push(child);
      }
      node = child;
    });
  }
  return root;
}

interface Harness {
  server: Server;
  baseUrl: string;
  canRead: ReturnType<typeof vi.fn>;
  canReadBatch: ReturnType<typeof vi.fn>;
}

async function makeHarness(opts: {
  files?: Record<string, string>;
  /** Folder-level read verdict. Defaults to readable. */
  canRead?: (repoRelPath: string) => boolean;
  /** Per-row read verdict on `governs`. Defaults to readable. */
  rowReadable?: (repoRelPath: string) => boolean;
}): Promise<Harness> {
  const files = opts.files ?? {};

  const canRead = vi.fn(async (_w: string, _e: string, p: string) =>
    opts.canRead ? opts.canRead(p) : true,
  );
  const canReadBatch = vi.fn(async (_w: string, _e: string, paths: string[]) => {
    const m = new Map<string, boolean>();
    for (const p of paths) m.set(p, opts.rowReadable ? opts.rowReadable(p) : true);
    return m;
  });

  const accessControl = { canRead, canReadBatch } as unknown as IAccessControl;

  const workspaceService = {
    listFiles: vi.fn(async () => buildTree(Object.keys(files))),
    readFile: vi.fn(async (_id: string, wsRel: string) => {
      const text = files[wsRel];
      if (text === undefined) throw new Error(`ENOENT ${wsRel}`);
      return text;
    }),
    getOrCreateForBranch: vi.fn(async () => ({ id: WS, name: WS, kbDirName: KB })),
  } as unknown as WorkspaceService;

  const authService = { getUserById: vi.fn(async () => USER) } as unknown as AuthService;
  const workflowService = {} as unknown as WorkflowService;
  const eventBus = { emit: vi.fn() } as unknown as WorkflowEventBus;
  const db = {} as unknown as Database;

  const app = express();
  app.use(express.json());
  app.use('/api', (req, _res, next) => {
    (req as unknown as { userId: string }).userId = USER.id;
    next();
  });
  app.use(
    '/api',
    createAccessRoutes(accessControl, workspaceService, authService, workflowService, eventBus, db, KB),
  );

  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${addr.port}`, canRead, canReadBatch };
}

function close(s: Server): Promise<void> {
  return new Promise((resolve, reject) => s.close((e) => (e ? reject(e) : resolve())));
}

const fm = (body: string) => `---\n${body}\n---\n\n# Body\n`;

const FILES = {
  [`${KB}/Groups/GTM/access.md`]: fm('read:\n  - GTM Team'),
  [`${KB}/Groups/GTM/battlecards/access.md`]: fm('read:\n  - deny everyone'),
  [`${KB}/Groups/GTM/slack.tool`]: fm('owner: Ali <ali@bevel.software>'),
};

describe('GET /access/overrides', () => {
  let h: Harness | null = null;
  afterEach(async () => {
    if (h) await close(h.server);
    h = null;
  });

  const get = (path: string) =>
    fetch(
      `${h!.baseUrl}/api/workspace/${encodeURIComponent(WS)}/access/overrides?path=${encodeURIComponent(path)}`,
    );

  it('returns the declarations under a folder the caller can read', async () => {
    h = await makeHarness({ files: FILES });

    const res = await get('Groups/GTM');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      truncated: false,
      overrides: [
        {
          path: 'Groups/GTM/battlecards/access.md',
          governs: 'Groups/GTM/battlecards',
          source: 'access-md',
          entries: [{ verb: 'read', deny: true, principal: { kind: 'everyone' } }],
        },
        {
          path: 'Groups/GTM/slack.tool',
          governs: 'Groups/GTM/slack.tool',
          source: 'frontmatter',
          entries: [
            {
              verb: 'owner',
              deny: false,
              principal: { kind: 'user', email: 'ali@bevel.software', name: 'Ali' },
            },
          ],
        },
      ],
    });
  });

  it('403s a caller who cannot read the folder', async () => {
    h = await makeHarness({ files: FILES, canRead: () => false });

    const res = await get('Groups/GTM');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'You do not have access to this folder.' });
  });

  it('drops rows governing something the caller cannot read', async () => {
    h = await makeHarness({
      files: FILES,
      rowReadable: (p) => p !== 'Groups/GTM/battlecards',
    });

    const res = await get('Groups/GTM');
    const body = (await res.json()) as { overrides: { path: string }[] };
    expect(body.overrides.map((o) => o.path)).toEqual(['Groups/GTM/slack.tool']);
  });

  it('accepts a workspace-relative path exactly like a repo-relative one', async () => {
    h = await makeHarness({ files: FILES });

    const repoRel = (await (await get('Groups/GTM')).json()) as unknown;
    const wsRel = (await (await get(`${KB}/Groups/GTM`)).json()) as unknown;
    expect(wsRel).toEqual(repoRel);
    expect(h.canRead).toHaveBeenCalledWith(WS, USER.email, 'Groups/GTM');
  });

  it('400s a path that escapes the KB repo', async () => {
    h = await makeHarness({ files: FILES });

    expect((await get(`${KB}/../tmp`)).status).toBe(400);
    expect((await get('/etc/passwd')).status).toBe(400);
  });

  it('400s a target that is a file, not a folder', async () => {
    h = await makeHarness({ files: FILES });

    const res = await get('Groups/GTM/slack.tool');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'path must be a folder' });
  });

  it('400s a missing path parameter', async () => {
    h = await makeHarness({ files: FILES });

    const res = await fetch(
      `${h.baseUrl}/api/workspace/${encodeURIComponent(WS)}/access/overrides`,
    );
    expect(res.status).toBe(400);
  });
});
