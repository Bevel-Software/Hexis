import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { testKbContext } from '../../../__tests__/kb-context.js';

import { NodeFs } from '../../kb-fs/node-fs.js';
import type { IWorkflowService } from '@bevel-software/platform-shared';
import type { ICreatorAccess } from '../../access-model/creator.js';
import type { IAdminAccessService } from '../../admin/admin.interface.js';
import type { WorkflowEventBus } from '../../workflow/event-bus.js';
import type { AuthService } from '../../auth/auth.service.js';
import { AccessControlService } from '../../access/access-control.service.js';
import { createWorkspaceRoutes } from '../workspace.routes.js';
import type { WorkspaceService } from '../workspace.service.js';

/**
 * The raw-file route over the REAL resolver, on a path whose only rule is a
 * `download:` grant.
 *
 * This is the combination the ticket was filed for: the route read-gates
 * before it download-gates, so before `download` folded into `read` a
 * download-only grantee was refused at the FIRST gate and could neither open
 * the file nor save it. Every other route test stubs the access service, so
 * only a test wired to the real one can show the two gates agreeing.
 */

const KB = 'knowledge-base';
const WORKSPACE_ID = 'target-company-state';
const FILE = `${KB}/Knowledge/Deal.md`;
const BYTES = 'hello world';

const stubCreatorAccess: ICreatorAccess = {
  planForCreate: async () => null,
  grantInExtractedFile: async () => null,
  noteAccessFileWritten: () => {},
};

/** Who the stubbed auth layer says the caller is — set per test before the request. */
let caller = { id: 'user-1', email: 'ana@x.io', name: 'Ana' };

const ROLES_YAML = `roles:
  Admin:
    - admin@x.io
`;

interface Harness {
  server: Server;
  baseUrl: string;
}

describe('GET /file/raw on a download-only path (real resolver)', () => {
  let root: string;
  let h: Harness | null = null;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-dl-read-route-'));
    caller = { id: 'user-1', email: 'ana@x.io', name: 'Ana' };
  });

  afterEach(async () => {
    if (h) {
      await new Promise<void>((resolve, reject) => h!.server.close((e) => (e ? reject(e) : resolve())));
      h = null;
    }
    await fs.rm(root, { recursive: true, force: true });
  });

  async function makeHarness(files: Record<string, string>): Promise<Harness> {
    const workspaceDir = path.join(root, WORKSPACE_ID);
    const repo = path.join(workspaceDir, KB);
    for (const [rel, contents] of Object.entries({ 'roles.yaml': ROLES_YAML, ...files })) {
      const abs = path.join(repo, rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, contents);
    }

    const workspaceService = {
      getWorkspacePath: async (id: string) => {
        if (id !== WORKSPACE_ID) throw new Error(`unexpected workspace ${id}`);
        return workspaceDir;
      },
      ensureRemotesFetched: async () => undefined,
      readFileBinary: async () => Buffer.from(BYTES),
    } as unknown as WorkspaceService;

    const accessControl = new AccessControlService(workspaceService, KB, new NodeFs());
    const authService = { getUserById: async () => caller } as unknown as AuthService;

    const app = express();
    app.use(express.json());
    app.use('/api', (req, _res, next) => {
      (req as unknown as { userId: string }).userId = caller.id;
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
    return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
  }

  const raw = (base: string, download: boolean) =>
    fetch(
      `${base}/api/workspace/${WORKSPACE_ID}/file/raw?path=${encodeURIComponent(FILE)}` +
        (download ? '&download=1' : ''),
    );

  it('serves the bytes inline AND as a download to a download-only grantee', async () => {
    h = await makeHarness({
      'Knowledge/access.md': '---\n---\ndownload:\n  - Ana <ana@x.io>\n',
    });

    const inline = await raw(h.baseUrl, false);
    expect(inline.status).toBe(200);
    expect(await inline.text()).toBe(BYTES);

    const saved = await raw(h.baseUrl, true);
    expect(saved.status).toBe(200);
    expect(saved.headers.get('content-disposition')).toContain('attachment');
    expect(await saved.text()).toBe(BYTES);
  });

  it('still refuses both to someone with no grant at all', async () => {
    h = await makeHarness({
      'Knowledge/access.md': '---\n---\ndownload:\n  - Ana <ana@x.io>\n',
    });
    caller = { id: 'user-2', email: 'mallory@x.io', name: 'Mallory' };

    expect((await raw(h.baseUrl, false)).status).toBe(403);
    expect((await raw(h.baseUrl, true)).status).toBe(403);
  });

  it('a `deny download` beside an inherited read leaves the file open but unsavable', async () => {
    h = await makeHarness({
      'access.md': '---\n---\nread:\n  - Ana <ana@x.io>\n',
      'Knowledge/access.md': '---\n---\ndownload:\n  - deny Ana <ana@x.io>\n',
    });

    expect((await raw(h.baseUrl, false)).status).toBe(200);
    const saved = await raw(h.baseUrl, true);
    expect(saved.status).toBe(403);
    expect((await saved.json()).error).toMatch(/download permission required/i);
  });
});
