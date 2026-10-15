import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { describe, it, expect, afterEach, vi } from 'vitest';

import type { IAccessControl } from '../access-control.interface.js';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import type { AuthService } from '../../auth/auth.service.js';
import type { WorkflowService } from '../../workflow/workflow.service.js';
import type { WorkflowEventBus } from '../../workflow/event-bus.js';
import { createAccessRoutes } from '../access.routes.js';
import { usersDbDouble } from './users-db-double.js';
import { testKbContext } from '../../../__tests__/kb-context.js';
import { NodeFs } from '../../kb-fs/node-fs.js';

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
  /** Whether the caller is an admin, who is offered every group. Defaults to true. */
  admin?: boolean;
  /** The groups the caller is a member of — all a non-admin is offered, or may grant to. */
  memberOf?: string[];
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
    holdsAdminRootWrite: vi.fn(async () => opts.admin ?? true),
    groupsOfUser: vi.fn(async () => opts.memberOf ?? []),
    eligibleWriters: vi.fn(async () => ({ roles: [], users: [] })),
    eligibleReaders: vi.fn(async () => ({ restricted: true, roles: [], users: [] })),
    eligibleOwners: vi.fn(async () => ({ roles: [], users: [] })),
    eligibleDownloaders: vi.fn(async () => ({ roles: [], users: [] })),
  } as unknown as IAccessControl;

  const workspaceService = {
    withPathTurn: async (_id: string, _p: string, op: () => Promise<unknown>) => op(),
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
    readFileBinary: vi.fn(async (_id: string, wsRel: string) =>
      Buffer.from(await (workspaceService.readFile as (id: string, p: string) => Promise<string>)(_id, wsRel), 'utf-8'),
    ),
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
  const db = usersDbDouble();

  const app = express();
  app.use(express.json());
  app.use('/api', (req, _res, next) => {
    (req as unknown as { userId: string }).userId = USER.id;
    next();
  });
  app.use('/api', createAccessRoutes(accessControl, workspaceService, authService, authService, workflowService, eventBus, db, testKbContext({ kbDirName: KB }), new NodeFs()));

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

  it('grants read to a known group — spliced as the explicit group/<Name> token', async () => {
    h = await makeHarness({ groups: ['GTM Team', 'Product'] });
    const res = await post('grant', {
      path: `${KB}/Sales`,
      kind: 'folder',
      verb: 'read',
      principal: { kind: 'group', group: 'GTM Team' },
    });
    expect(res.status).toBe(200);
    const md = h.files.get(`${KB}/Sales/access.md`)!;
    expect(md.split('\n')).toContain('  - group/GTM Team'); // never the bare name
    expect(md).not.toContain('role/');
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

  it('a group sharing a role name is grantable — each kind is written with its prefix (no refusal)', async () => {
    h = await makeHarness({ roles: ['Everyone', 'Product'], groups: ['Product'] });
    const asGroup = await post('grant', {
      path: `${KB}/Sales`,
      kind: 'folder',
      verb: 'read',
      principal: { kind: 'group', group: 'Product' },
    });
    expect(asGroup.status).toBe(200);
    expect(h.files.get(`${KB}/Sales/access.md`)).toContain('- group/Product');
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

  it("suggest offers someone who is not an admin only the groups they are in, never another group's name", async () => {
    h = await makeHarness({ roles: ['Everyone'], groups: ['GTM Team', 'Product'], admin: false, memberOf: ['Product'] });
    const res = await fetch(`${h.baseUrl}/api/workspace/${encodeURIComponent(WS)}/access/suggest?q=`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { roles: string[]; groups: string[] };
    expect(body.groups).toEqual(['Product']);
    expect(body.roles).toEqual(['Everyone']); // roles are not withheld
  });

  it('suggest offers someone in no group, who is not an admin, no groups at all', async () => {
    h = await makeHarness({ groups: ['GTM Team', 'Product'], admin: false });
    const res = await fetch(`${h.baseUrl}/api/workspace/${encodeURIComponent(WS)}/access/suggest?q=`);
    const body = (await res.json()) as { groups: string[] };
    expect(body.groups).toEqual([]);
  });

  it('a non-admin grants to a group they are in', async () => {
    h = await makeHarness({ groups: ['GTM Team', 'Product'], admin: false, memberOf: ['Product'] });
    const res = await post('grant', {
      path: `${KB}/Sales`,
      kind: 'folder',
      verb: 'read',
      principal: { kind: 'group', group: 'Product' },
    });
    expect(res.status).toBe(200);
    expect(h.files.get(`${KB}/Sales/access.md`)).toContain('- group/Product');
  });

  it('a group named with its group/ prefix is written once-prefixed', async () => {
    h = await makeHarness({ groups: ['GTM Team'] });
    const res = await post('grant', {
      path: `${KB}/Sales`,
      kind: 'folder',
      verb: 'read',
      principal: { kind: 'group', group: 'group/GTM Team' },
    });
    expect(res.status).toBe(200);
    expect(h.files.get(`${KB}/Sales/access.md`)!.split('\n')).toContain('  - group/GTM Team');
  });

  it('a non-admin granting to a group they are not in is refused exactly like an unknown group', async () => {
    h = await makeHarness({ groups: ['GTM Team', 'Product'], admin: false, memberOf: ['Product'] });
    const res = await post('grant', {
      path: `${KB}/Sales`,
      kind: 'folder',
      verb: 'read',
      principal: { kind: 'group', group: 'GTM Team' },
    });
    // Same status, same body as a group that does not exist — the WHOLE
    // answer, message included, with only the name asked about differing —
    // so the grant route confirms no group name the picker would not have
    // offered.
    const ghost = await post('grant', {
      path: `${KB}/Sales`,
      kind: 'folder',
      verb: 'read',
      principal: { kind: 'group', group: 'Ghost Team' },
    });
    expect(res.status).toBe(404);
    expect(ghost.status).toBe(404);
    const hiddenBody = (await res.json()) as Record<string, unknown>;
    const ghostBody = (await ghost.json()) as Record<string, unknown>;
    expect(hiddenBody).toMatchObject({ kind: 'unknown-group', group: 'GTM Team' });
    expect(JSON.stringify(hiddenBody).replaceAll('GTM Team', 'Ghost Team')).toBe(JSON.stringify(ghostBody));
    expect(h.files.has(`${KB}/Sales/access.md`)).toBe(false);
  });

  it('revokes with a group principal (name-based, no existence check)', async () => {
    h = await makeHarness({
      roles: ['Everyone'],
      groups: ['GTM Team'],
      files: {
        // Both spellings: the legacy bare one and the explicit one.
        [`${KB}/Sales/access.md`]: '---\nread:\n  - Vanished Team\n  - group/Vanished Team\n---\n',
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

  it('granting a GROUP that shares an already-granted role name is NOT swallowed as idempotent', async () => {
    h = await makeHarness({
      roles: ['Everyone', 'Product'],
      groups: ['Product'],
      files: { [`${KB}/Sales/access.md`]: '---\nread:\n  - role/Product\n  - Product\n---\n' },
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
    expect(md.split('\n')).toContain('  - group/Product'); // the group's token landed
  });

  it("revoking the ROLE while a same-named GROUP is granted leaves the group's token", async () => {
    h = await makeHarness({
      roles: ['Everyone', 'Product'],
      groups: ['Product'],
      files: {
        [`${KB}/Sales/access.md`]: '---\nwrite:\n  - Product\n  - role/Product\n  - group/Product\n---\n',
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
    expect(md.split('\n')).not.toContain('  - Product'); // the bare name was the role's
    expect(md.split('\n')).toContain('  - group/Product'); // the GROUP's grant survives
  });

  it("revoking the GROUP while a same-named ROLE is granted leaves the role's spellings", async () => {
    h = await makeHarness({
      roles: ['Everyone', 'Product'],
      groups: ['Product'],
      files: {
        [`${KB}/Sales/access.md`]: '---\nwrite:\n  - Product\n  - role/Product\n  - group/Product\n---\n',
      },
    });
    const res = await post('revoke', {
      path: `${KB}/Sales`,
      kind: 'folder',
      principal: { kind: 'group', group: 'Product' },
    });
    expect(res.status).toBe(200);
    const md = h.files.get(`${KB}/Sales/access.md`)!;
    expect(md).not.toContain('group/Product');
    expect(md.split('\n')).toContain('  - Product');
    expect(md).toContain('- role/Product');
  });
});
