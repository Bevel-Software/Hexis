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
 * HTTP-level contract tests for GROUP and ROLE principals on the share
 * surface: the grant route's grammar (groups splice as the bare token, roles
 * as the explicit `role/<Name>` token), the dropped collision refusals
 * (precedence resolves them now), the suggest endpoint's `roles`+`groups`
 * lists (with the deprecated `plugins` alias), and revoke accepting the group
 * kind. These pin the ROUTE layer; the RESOLVER's group-first precedence and
 * the real kbPrincipals shape are covered in access-groups.test.ts /
 * access-mutation.service.test.ts against the real service.
 */

const USER = { id: 'u-1', email: 'alice@bevel.software', name: 'Alice' };
const WS = 'alice/feature'; // non-protected feature branch
const KB = 'knowledge-base';

async function makeHarness(opts: {
  files?: Record<string, string>;
  roles?: string[];
  groups?: string[];
}): Promise<{ server: Server; baseUrl: string; files: Map<string, string> }> {
  const files = new Map<string, string>(Object.entries(opts.files ?? {}));

  const accessControl = {
    canWrite: vi.fn(async () => true),
    canRead: vi.fn(async () => true),
    canDownload: vi.fn(async () => false),
    canOwner: vi.fn(async () => false),
    grantSources: vi.fn(async () => ({})),
    invalidate: vi.fn(),
    kbPrincipals: vi.fn(async () => ({
      roles: opts.roles ?? [],
      groups: opts.groups ?? [],
      people: [],
    })),
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

  it('grants read to a known group — spliced as the bare-name token', async () => {
    h = await makeHarness({ groups: ['GTM Team', 'Product'] });
    const res = await post('grant', {
      path: `${KB}/Sales`,
      kind: 'folder',
      verb: 'read',
      principal: { kind: 'group', group: 'GTM Team' },
    });
    expect(res.status).toBe(200);
    const md = h.files.get(`${KB}/Sales/access.md`)!;
    expect(md).toContain('- GTM Team');
    expect(md).not.toContain('role/'); // a GROUP grant is the bare token
  });

  it('grants a ROLE as the explicit role/<Name> token', async () => {
    h = await makeHarness({ roles: ['Everyone', 'Sales'] });
    const res = await post('grant', {
      path: `${KB}/Sales`,
      kind: 'folder',
      verb: 'write',
      principal: { kind: 'role', role: 'Sales' },
    });
    expect(res.status).toBe(200);
    expect(h.files.get(`${KB}/Sales/access.md`)).toContain('- role/Sales');
  });

  it('the built-in everyone grant stays a bare token (no role/ alias exists for it)', async () => {
    h = await makeHarness({ roles: ['Everyone'] });
    const res = await post('grant', {
      path: `${KB}/Sales`,
      kind: 'folder',
      verb: 'read',
      principal: { kind: 'role', role: 'Everyone' },
    });
    expect(res.status).toBe(200);
    const md = h.files.get(`${KB}/Sales/access.md`)!;
    expect(md).toContain('- Everyone');
    expect(md).not.toContain('role/Everyone');
  });

  it('404s an unknown group with a typed body', async () => {
    h = await makeHarness({ groups: ['GTM Team'] });
    const res = await post('grant', {
      path: `${KB}/Sales`,
      kind: 'folder',
      verb: 'read',
      principal: { kind: 'group', group: 'Ghost Team' },
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ kind: 'unknown-group', group: 'Ghost Team' });
  });

  it('404s an unknown role with a typed body', async () => {
    h = await makeHarness({ roles: ['Everyone'] });
    const res = await post('grant', {
      path: `${KB}/Sales`,
      kind: 'folder',
      verb: 'write',
      principal: { kind: 'role', role: 'Ghost Role' },
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ kind: 'unknown-role', role: 'Ghost Role' });
  });

  it('a group sharing a role name is grantable — precedence resolves it (no refusal)', async () => {
    h = await makeHarness({ roles: ['Everyone', 'Product'], groups: ['Product'] });
    const asGroup = await post('grant', {
      path: `${KB}/Sales`,
      kind: 'folder',
      verb: 'read',
      principal: { kind: 'group', group: 'Product' },
    });
    expect(asGroup.status).toBe(200);
    expect(h.files.get(`${KB}/Sales/access.md`)).toContain('- Product');
    // The ROLE of the same name grants as the explicit token, side by side.
    const asRole = await post('grant', {
      path: `${KB}/Sales`,
      kind: 'folder',
      verb: 'write',
      principal: { kind: 'role', role: 'Product' },
    });
    expect(asRole.status).toBe(200);
    expect(h.files.get(`${KB}/Sales/access.md`)).toContain('- role/Product');
  });

  it('suggest lists roles + groups without collision withholding, plus the deprecated plugins alias', async () => {
    h = await makeHarness({ roles: ['Everyone', 'Product'], groups: ['GTM Team', 'Product'] });
    const res = await fetch(
      `${h.baseUrl}/api/workspace/${encodeURIComponent(WS)}/access/suggest?q=`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { roles: string[]; groups: string[]; plugins: string[] };
    expect(body.groups).toEqual(['GTM Team', 'Product']); // nothing withheld
    expect(body.roles).toEqual(['Everyone', 'Product']);
    // Deprecated alias — keeps the shipped dialog alive for one release.
    expect(body.plugins).toEqual(body.roles);
  });

  it('revokes with a group principal (name-based, no existence check)', async () => {
    h = await makeHarness({
      groups: ['GTM Team'],
      files: {
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

  it('revoking a ROLE strips both spellings (legacy bare + role/ token)', async () => {
    h = await makeHarness({
      roles: ['Everyone', 'Sales'],
      files: {
        [`${KB}/Sales/access.md`]: '---\nwrite:\n  - Sales\n  - role/Sales\n  - Admin\n---\n',
      },
    });
    const res = await post('revoke', {
      path: `${KB}/Sales`,
      kind: 'folder',
      principal: { kind: 'role', role: 'Sales' },
    });
    expect(res.status).toBe(200);
    const md = h.files.get(`${KB}/Sales/access.md`)!;
    expect(md).not.toContain('Sales');
    expect(md).toContain('- Admin'); // untouched
  });
});

describe('token-kind family at the route boundary', () => {
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

  it("granting 'role/Everyone' normalizes to the bare built-in — never the dead role/everyone token", async () => {
    h = await makeHarness({ roles: ['Everyone'] });
    const res = await post('grant', {
      path: `${KB}/Open`,
      kind: 'folder',
      verb: 'read',
      principal: { kind: 'role', role: 'role/Everyone' },
    });
    expect(res.status).toBe(200);
    const md = h.files.get(`${KB}/Open/access.md`)!;
    expect(md).toContain('- Everyone');
    expect(md).not.toContain('role/');
  });

  it("granting 'role/Everyone' a non-read verb is refused like the bare spelling", async () => {
    h = await makeHarness({ roles: ['Everyone'] });
    const res = await post('grant', {
      path: `${KB}/Open`,
      kind: 'folder',
      verb: 'write',
      principal: { kind: 'role', role: 'role/Everyone' },
    });
    expect(res.status).toBe(400);
  });

  it("revoking 'role/Everyone' strips a bare everyone grant (symmetric normalization)", async () => {
    h = await makeHarness({
      roles: ['Everyone'],
      files: { [`${KB}/Open/access.md`]: '---\nread:\n  - everyone\n  - Admin\n---\n' },
    });
    const res = await post('revoke', {
      path: `${KB}/Open`,
      kind: 'folder',
      principal: { kind: 'role', role: 'role/Everyone' },
    });
    expect(res.status).toBe(200);
    const md = h.files.get(`${KB}/Open/access.md`)!;
    expect(md).not.toContain('everyone');
    expect(md).toContain('- Admin');
  });

  it('granting a GROUP that shadows an already-granted role/<Name> is NOT swallowed as idempotent', async () => {
    h = await makeHarness({
      roles: ['Everyone', 'Product'],
      groups: ['Product'],
      files: { [`${KB}/Sales/access.md`]: '---\nread:\n  - role/Product\n---\n' },
    });
    const res = await post('grant', {
      path: `${KB}/Sales`,
      kind: 'folder',
      verb: 'read',
      principal: { kind: 'group', group: 'Product' },
    });
    expect(res.status).toBe(200);
    const md = h.files.get(`${KB}/Sales/access.md`)!;
    expect(md).toContain('- role/Product');
    expect(md.split('\n')).toContain('  - Product'); // the group's bare token landed
  });

  it('revoking the ROLE while a same-named GROUP is granted leaves the bare token (kbPrincipals-driven shadowing)', async () => {
    h = await makeHarness({
      roles: ['Everyone', 'Product'],
      groups: ['Product'],
      files: {
        [`${KB}/Sales/access.md`]: '---\nwrite:\n  - Product\n  - role/Product\n---\n',
      },
    });
    const res = await post('revoke', {
      path: `${KB}/Sales`,
      kind: 'folder',
      principal: { kind: 'role', role: 'Product' },
    });
    expect(res.status).toBe(200);
    const md = h.files.get(`${KB}/Sales/access.md`)!;
    expect(md).not.toContain('role/Product');
    expect(md.split('\n')).toContain('  - Product'); // the GROUP's grant survives
  });
});
