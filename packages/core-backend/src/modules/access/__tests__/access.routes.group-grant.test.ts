import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { describe, it, expect, afterEach, vi } from 'vitest';

import type { IAccessControl } from '../access-control.interface.js';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import type { AuthService } from '../../auth/auth.service.js';
import type { WorkflowService } from '../../workflow/workflow.service.js';
import type { WorkflowEventBus } from '../../workflow/event-bus.js';
import type { Database } from '../../database/connection.js';
import { createAccessRoutes } from '../access.routes.js';

/**
 * HTTP-level contract tests for GROUP principals on the share surface: the
 * grant route's group grammar + validation (active-source membership,
 * plugin-name precedence refusal), the suggest endpoint's `groups` list, and
 * revoke accepting the group kind. The splice below the route is the same
 * bare-name token a plugin grant writes — these tests pin the ROUTE layer.
 */

const USER = { id: 'u-1', email: 'alice@bevel.software', name: 'Alice' };
const WS = 'alice/feature'; // non-protected feature branch
const KB = 'knowledge-base';

async function makeHarness(opts: {
  files?: Record<string, string>;
  plugins?: string[];
}): Promise<{ server: Server; baseUrl: string; files: Map<string, string> }> {
  const files = new Map<string, string>(Object.entries(opts.files ?? {}));

  const accessControl = {
    canWrite: vi.fn(async () => true),
    canRead: vi.fn(async () => true),
    canDownload: vi.fn(async () => false),
    canOwner: vi.fn(async () => false),
    grantSources: vi.fn(async () => ({})),
    invalidate: vi.fn(),
    kbPrincipals: vi.fn(async () => ({ plugins: opts.plugins ?? [], people: [] })),
    eligibleWriters: vi.fn(async () => ({ roles: [], users: [] })),
    eligibleReaders: vi.fn(async () => ({ restricted: true, roles: [], users: [] })),
    eligibleOwners: vi.fn(async () => ({ roles: [], users: [] })),
    eligibleDownloaders: vi.fn(async () => ({ roles: [], users: [] })),
  } as unknown as IAccessControl;

  const workspaceService = {
    getOrCreateForBranch: vi.fn(async () => ({ id: WS, name: WS, kbDirName: KB })),
    readFile: vi.fn(async (_id: string, wsRel: string) => {
      const v = files.get(wsRel);
      if (v === undefined) {
        const err = new Error(`ENOENT ${wsRel}`) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return v;
    }),
    writeFile: vi.fn(async (_id: string, wsRel: string, content: string) => {
      files.set(wsRel, content);
    }),
  } as unknown as WorkspaceService;

  const authService = { getUserById: vi.fn(async () => USER) } as unknown as AuthService;
  const workflowService = {
    getLock: vi.fn(async () => null),
    acquireLock: vi.fn(async () => ({ acquired: true, lock: {} })),
    releaseLock: vi.fn(async () => undefined),
    releaseLockNoCommit: vi.fn(async () => undefined),
  } as unknown as WorkflowService;
  const eventBus = { emit: vi.fn() } as unknown as WorkflowEventBus;
  const db = {} as unknown as Database;

  const app = express();
  app.use(express.json());
  app.use('/api', (req, _res, next) => {
    (req as unknown as { userId: string }).userId = USER.id;
    next();
  });
  app.use('/api', createAccessRoutes(accessControl, workspaceService, authService, workflowService, eventBus, db, KB));

  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${addr.port}`, files };
}

function close(s: Server): Promise<void> {
  return new Promise((resolve, reject) => s.close((e) => (e ? reject(e) : resolve())));
}

const GROUPS_FILE = 'groups:\n  GTM Team:\n    - pat@x.io\n  Product:\n    - lee@x.io\n';

describe('group principals on the share surface', () => {
  let h: Awaited<ReturnType<typeof makeHarness>> | null = null;
  afterEach(async () => {
    if (h) await close(h.server);
    h = null;
  });

  const post = (route: string, body: unknown) =>
    fetch(`${h!.baseUrl}/api/workspace/${encodeURIComponent(WS)}/access/${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('grants read to a known manual group — spliced as the bare-name token', async () => {
    h = await makeHarness({ files: { [`${KB}/groups.yaml`]: GROUPS_FILE } });
    const res = await post('grant', {
      path: `${KB}/Sales`,
      kind: 'folder',
      verb: 'read',
      principal: { kind: 'group', group: 'GTM Team' },
    });
    expect(res.status).toBe(200);
    expect(h.files.get(`${KB}/Sales/access.md`)).toContain('GTM Team');
  });

  it('grants to a synced group when the deployment is in IdP mode', async () => {
    h = await makeHarness({
      files: {
        // Synced file present → it IS the active source; the manual file is ignored.
        [`${KB}/synced-groups.yaml`]: 'groups:\n  Engineering:\n    - ada@x.io\n',
        [`${KB}/groups.yaml`]: GROUPS_FILE,
      },
    });
    const ok = await post('grant', {
      path: `${KB}/Sales`,
      kind: 'folder',
      verb: 'read',
      principal: { kind: 'group', group: 'Engineering' },
    });
    expect(ok.status).toBe(200);
    // The retired manual file no longer validates grants.
    const stale = await post('grant', {
      path: `${KB}/Sales`,
      kind: 'folder',
      verb: 'read',
      principal: { kind: 'group', group: 'GTM Team' },
    });
    expect(stale.status).toBe(404);
  });

  it('404s an unknown group with a typed body', async () => {
    h = await makeHarness({ files: { [`${KB}/groups.yaml`]: GROUPS_FILE } });
    const res = await post('grant', {
      path: `${KB}/Sales`,
      kind: 'folder',
      verb: 'read',
      principal: { kind: 'group', group: 'Ghost Team' },
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ kind: 'unknown-group', group: 'Ghost Team' });
  });

  it('refuses a group whose name a plugin already owns (plugin precedence)', async () => {
    h = await makeHarness({
      files: { [`${KB}/groups.yaml`]: GROUPS_FILE },
      plugins: ['Product'],
    });
    const res = await post('grant', {
      path: `${KB}/Sales`,
      kind: 'folder',
      verb: 'read',
      principal: { kind: 'group', group: 'Product' },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('is a plugin');
  });

  it('suggest lists active groups, withholding plugin-name collisions', async () => {
    h = await makeHarness({
      files: { [`${KB}/groups.yaml`]: GROUPS_FILE },
      plugins: ['Product'],
    });
    const res = await fetch(
      `${h.baseUrl}/api/workspace/${encodeURIComponent(WS)}/access/suggest?q=`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { plugins: string[]; groups: string[] };
    expect(body.groups).toEqual(['GTM Team']); // Product withheld: the plugin wins
    expect(body.plugins).toEqual(['Product']);
  });

  it('revokes with a group principal (name-based, no existence check)', async () => {
    h = await makeHarness({
      files: {
        [`${KB}/groups.yaml`]: GROUPS_FILE,
        [`${KB}/Sales/access.md`]: '---\nread:\n  - Vanished Team\n---\n',
      },
    });
    const res = await post('revoke', {
      path: `${KB}/Sales`,
      kind: 'folder',
      principal: { kind: 'group', group: 'Vanished Team' },
    });
    expect(res.status).toBe(200);
    expect(h.files.get(`${KB}/Sales/access.md`)).not.toContain('Vanished Team');
  });
});
