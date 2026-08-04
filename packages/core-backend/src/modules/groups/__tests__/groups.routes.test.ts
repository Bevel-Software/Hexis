import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import { describe, it, expect, afterEach, vi } from 'vitest';

import { DEFAULT_BRANCH } from '@bevel-software/platform-shared';
import { workspaceIdForBranch } from '../../workspace/workspace.service.js';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import type { IAccessControl } from '../../access/access-control.interface.js';
import type { ISkillService, SkillSummary } from '../../skills/skills.contract.js';
import type { IToolManualService, ToolManualSummary } from '../../tool-manuals/tool-manuals.contract.js';
import { GroupIndexService } from '../groups.service.js';
import { createGroupsRoutes } from '../groups.routes.js';
import type {
  AccessRequestRow,
  AccessRequestsService,
} from '../access-requests.service.js';
import type { GroupSummary, IGroupIndexService } from '../groups.contract.js';

/**
 * HTTP-level contract for the four `/api/groups*` endpoints: the auth gate, the
 * merged DTO's per-caller half (canRead / canWrite / withheld readers / stripped
 * emails / hasRequested), lazy fulfillment on both sides, and the admin filter
 * that turns a non-admin's request list into `[]` rather than a 403.
 *
 * The group index is REAL over a temp KB (so the folder union and the counts are
 * exercised end to end); access control and the request store are stubs, because
 * what's under test here is the route's use of them.
 */

const KB = 'knowledge-base';
const wsId = workspaceIdForBranch(DEFAULT_BRANCH);
const OLGA = { name: 'Olga Ivanova', email: 'olga@bevel.software' };
const ALI = 'ali@bevel.software';

const tmpDirs: string[] = [];

/** In-memory stand-in for `AccessRequestsService` (the DB half is tested separately). */
function makeRequests(seed: AccessRequestRow[] = []) {
  const rows = seed.map((r) => ({ ...r, status: 'pending' }));
  let seq = seed.length;
  return {
    _rows: rows,
    create: vi.fn(async (group: string, email: string, name: string) => {
      if (rows.some((r) => r.status === 'pending' && r.groupName === group && r.requesterEmail === email.toLowerCase())) {
        return;
      }
      rows.push({
        id: `req-${++seq}`,
        groupName: group,
        requesterEmail: email.toLowerCase(),
        requesterName: name,
        createdAt: new Date(1_700_000_000_000 + seq),
        status: 'pending',
      });
    }),
    pendingByRequester: vi.fn(async (email: string) =>
      rows
        .filter((r) => r.status === 'pending' && r.requesterEmail === email.toLowerCase())
        .map((r) => ({ id: r.id, groupName: r.groupName })),
    ),
    pendingAll: vi.fn(async () => rows.filter((r) => r.status === 'pending').map((r) => ({ ...r }))),
    getPending: vi.fn(async (id: string) => rows.find((r) => r.id === id && r.status === 'pending') ?? null),
    markFulfilled: vi.fn(async (ids: string[]) => {
      for (const r of rows) if (ids.includes(r.id) && r.status === 'pending') r.status = 'fulfilled';
    }),
    dismiss: vi.fn(async (id: string) => {
      const row = rows.find((r) => r.id === id && r.status === 'pending');
      if (!row) return false;
      row.status = 'dismissed';
      return true;
    }),
  };
}

interface HarnessOpts {
  /** Folders (`Groups/GTM`) the given email may read. */
  readable?: Record<string, string[]>;
  /** Folders the given email may write `access.md` on. */
  writable?: Record<string, string[]>;
  requests?: ReturnType<typeof makeRequests>;
  /** Override the whole index (used to force the 500 path). */
  index?: IGroupIndexService;
  email?: string | null;
  skills?: SkillSummary[];
  tools?: ToolManualSummary[];
}

async function makeHarness(opts: HarnessOpts = {}) {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-groups-routes-'));
  tmpDirs.push(workspaceDir);
  const kbRoot = path.join(workspaceDir, KB);
  await fs.mkdir(path.join(kbRoot, 'Groups', 'GTM'), { recursive: true });
  await fs.mkdir(path.join(kbRoot, 'Groups', 'Finance'), { recursive: true });

  const workspaceService = {
    getOrCreateForBranch: async () => ({ id: wsId }),
    getWorkspacePath: async () => workspaceDir,
  } as unknown as WorkspaceService;

  const verdictFor = (table: Record<string, string[]> | undefined, email: string, paths: string[]) =>
    new Map(
      paths.map((p) => [p, (table?.[email] ?? []).some((folder) => p === `${folder}/access.md`)]),
    );

  const accessControl = {
    canReadBatch: vi.fn(async (_w: string, email: string, paths: string[]) =>
      verdictFor(opts.readable, email, paths),
    ),
    canWriteBatch: vi.fn(async (_w: string, email: string, paths: string[]) =>
      verdictFor(opts.writable, email, paths),
    ),
    eligibleOwners: async () => ({ roles: [], users: [OLGA] }),
    eligibleWriters: async () => ({ roles: ['Admin'], users: [] }),
    eligibleReaders: async () => ({ restricted: true, roles: ['GTM Team'], users: [OLGA] }),
  } as unknown as IAccessControl;

  const skillService = { listSkills: async () => opts.skills ?? [] } as unknown as ISkillService;
  const toolService = {
    listAllSummaries: async () => opts.tools ?? [],
  } as unknown as IToolManualService;

  const index =
    opts.index ??
    new GroupIndexService(workspaceService, accessControl, skillService, toolService, KB);
  const requests = opts.requests ?? makeRequests();

  const email = opts.email === undefined ? ALI : opts.email;
  const app = express();
  app.use(express.json());
  app.use('/api', (req, _res, next) => {
    if (email) {
      req.userEmail = email;
      req.userId = 'u-1';
    }
    next();
  });
  app.use(
    '/api',
    createGroupsRoutes(
      index,
      requests as unknown as AccessRequestsService,
      accessControl,
      async () => 'Ali Baba',
    ),
  );

  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${addr.port}`, requests, accessControl };
}

function close(s: Server): Promise<void> {
  return new Promise((resolve, reject) => s.close((e) => (e ? reject(e) : resolve())));
}

describe('/api/groups routes', () => {
  let server: Server | null = null;
  afterEach(async () => {
    if (server) await close(server);
    server = null;
    await Promise.all(tmpDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  const listGroups = async (baseUrl: string) => {
    const res = await fetch(`${baseUrl}/api/groups`);
    const body = (await res.json()) as { groups: GroupSummary[] };
    return { status: res.status, groups: body.groups };
  };

  it('401s every endpoint when req.userEmail is absent', async () => {
    const h = await makeHarness({ email: null });
    server = h.server;
    for (const [method, url] of [
      ['GET', '/api/groups'],
      ['POST', '/api/groups/GTM/access-requests'],
      ['GET', '/api/groups/access-requests'],
      ['POST', '/api/groups/access-requests/req-1/dismiss'],
    ] as const) {
      const res = await fetch(`${h.baseUrl}${url}`, { method });
      expect(res.status, `${method} ${url}`).toBe(401);
      expect(await res.json()).toEqual({ error: 'Unauthenticated' });
    }
  });

  it('sorts by name and counts by groupOfPath (ungrouped items count nowhere)', async () => {
    const h = await makeHarness({
      skills: [{ name: 'outreach', description: '', path: 'Groups/GTM/outreach' }],
      tools: [
        { slug: 'ledger', name: 'ledger', path: 'Groups/Finance/ledger.tool', type: 'inline' },
        { slug: 'slack', name: 'slack', path: 'Groups/slack.tool', type: 'inline' },
      ],
    });
    server = h.server;
    const { status, groups } = await listGroups(h.baseUrl);
    expect(status).toBe(200);
    expect(groups.map((g) => g.name)).toEqual(['Finance', 'GTM']);
    expect(groups[0].folders).toEqual(['Groups/Finance']);
    expect(groups[0]).toMatchObject({ skillCount: 0, toolCount: 1 });
    expect(groups[1]).toMatchObject({ folders: ['Groups/GTM'], skillCount: 1, toolCount: 0 });
  });

  it('resolves canRead/canWrite per group and withholds readers when locked', async () => {
    const h = await makeHarness({
      readable: { [ALI]: ['Groups/Finance'] },
      writable: { [ALI]: [] },
    });
    server = h.server;
    const { groups } = await listGroups(h.baseUrl);
    const finance = groups.find((g) => g.name === 'Finance')!;
    const gtm = groups.find((g) => g.name === 'GTM')!;

    expect(finance.canRead).toBe(true);
    expect(finance.readers).toEqual({ restricted: true, roles: ['GTM Team'], users: [OLGA] });
    expect(finance.owners.users).toEqual([OLGA]);

    // Locked: counts and run-by survive, the share list and every email do not.
    expect(gtm.canRead).toBe(false);
    expect(gtm.readers).toBeNull();
    expect(gtm.owners.users).toEqual([{ name: 'Olga Ivanova', email: null }]);
    expect(gtm.writers.roles).toEqual(['Admin']);
    expect(JSON.stringify(gtm)).not.toContain('@');
  });

  it('gives a locked-out folder-writer canWrite: true (the admin-rescue way back in)', async () => {
    const h = await makeHarness({ readable: { [ALI]: [] }, writable: { [ALI]: ['Groups/GTM'] } });
    server = h.server;
    const { groups } = await listGroups(h.baseUrl);
    const gtm = groups.find((g) => g.name === 'GTM')!;
    expect(gtm).toMatchObject({ canRead: false, canWrite: true });
  });

  it('sets hasRequested for a pending request and lazily fulfills it once readable', async () => {
    const requests = makeRequests([
      {
        id: 'req-1',
        groupName: 'GTM',
        requesterEmail: ALI,
        requesterName: 'Ali Baba',
        createdAt: new Date(1_700_000_000_000),
      },
    ]);
    const locked = await makeHarness({ requests, readable: { [ALI]: [] } });
    server = locked.server;
    const first = await listGroups(locked.baseUrl);
    expect(first.groups.find((g) => g.name === 'GTM')!.hasRequested).toBe(true);
    expect(requests.markFulfilled).not.toHaveBeenCalled();
    await close(locked.server);

    // Access lands; the next load retires the row without an approve click.
    const granted = await makeHarness({ requests, readable: { [ALI]: ['Groups/GTM'] } });
    server = granted.server;
    const second = await listGroups(granted.baseUrl);
    const gtm = second.groups.find((g) => g.name === 'GTM')!;
    expect(gtm).toMatchObject({ canRead: true, hasRequested: false });
    expect(requests.markFulfilled).toHaveBeenCalledWith(['req-1']);
    expect(requests._rows[0].status).toBe('fulfilled');
  });

  it('degrades to hasRequested: false when the pending lookup throws', async () => {
    const requests = makeRequests();
    requests.pendingByRequester.mockRejectedValueOnce(new Error('db down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = await makeHarness({ requests });
    server = h.server;
    const { status, groups } = await listGroups(h.baseUrl);
    expect(status).toBe(200);
    expect(groups.every((g) => g.hasRequested === false)).toBe(true);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('500s with { error: "Failed to list groups" } when the index throws', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = await makeHarness({
      index: {
        catalog: async () => {
          throw new Error('boom');
        },
        invalidate: () => {},
      },
    });
    server = h.server;
    const res = await fetch(`${h.baseUrl}/api/groups`);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to list groups' });
    error.mockRestore();
  });

  it('POST access-requests: 404 unknown-group, 409 already-readable, 200 + idempotent repeat', async () => {
    const requests = makeRequests();
    const h = await makeHarness({ requests, readable: { [ALI]: ['Groups/Finance'] } });
    server = h.server;

    const unknown = await fetch(`${h.baseUrl}/api/groups/Nope/access-requests`, { method: 'POST' });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: 'Unknown group', kind: 'unknown-group' });

    const already = await fetch(`${h.baseUrl}/api/groups/Finance/access-requests`, { method: 'POST' });
    expect(already.status).toBe(409);
    expect(await already.json()).toEqual({
      error: 'You can already read this group',
      kind: 'already-readable',
    });

    for (const attempt of [1, 2]) {
      const ok = await fetch(`${h.baseUrl}/api/groups/GTM/access-requests`, { method: 'POST' });
      expect(ok.status, `attempt ${attempt}`).toBe(200);
      expect(await ok.json()).toEqual({ ok: true, hasRequested: true });
    }
    expect(requests._rows.filter((r) => r.status === 'pending')).toHaveLength(1);
    expect(requests._rows[0].requesterName).toBe('Ali Baba');
  });

  it('access-requests list: [] for a non-admin, the administered rows for a folder admin', async () => {
    const seed: AccessRequestRow[] = [
      {
        id: 'req-1',
        groupName: 'GTM',
        requesterEmail: ALI,
        requesterName: 'Ali Baba',
        createdAt: new Date(1_700_000_000_000),
      },
      {
        id: 'req-2',
        groupName: 'Finance',
        requesterEmail: 'juan@bevel.software',
        requesterName: 'Juan Viera',
        createdAt: new Date(1_700_000_000_001),
      },
    ];

    const outsider = await makeHarness({ requests: makeRequests(seed), email: 'nobody@bevel.software' });
    server = outsider.server;
    const none = await fetch(`${outsider.baseUrl}/api/groups/access-requests`);
    expect(none.status).toBe(200); // never a 403 — the frontend may ask unconditionally
    expect(await none.json()).toEqual({ requests: [] });
    await close(outsider.server);

    const admin = await makeHarness({
      requests: makeRequests(seed),
      email: OLGA.email,
      writable: { [OLGA.email]: ['Groups/GTM'] },
    });
    server = admin.server;
    const res = await fetch(`${admin.baseUrl}/api/groups/access-requests`);
    const body = (await res.json()) as { requests: { id: string; group: string; requesterEmail: string }[] };
    expect(body.requests).toHaveLength(1);
    expect(body.requests[0]).toMatchObject({ id: 'req-1', group: 'GTM', requesterEmail: ALI });
  });

  it('access-requests list hides rows whose requester can already read (lazy fulfillment)', async () => {
    const requests = makeRequests([
      {
        id: 'req-1',
        groupName: 'GTM',
        requesterEmail: ALI,
        requesterName: 'Ali Baba',
        createdAt: new Date(1_700_000_000_000),
      },
    ]);
    const h = await makeHarness({
      requests,
      email: OLGA.email,
      readable: { [ALI]: ['Groups/GTM'] },
      writable: { [OLGA.email]: ['Groups/GTM'] },
    });
    server = h.server;
    const res = await fetch(`${h.baseUrl}/api/groups/access-requests`);
    expect(await res.json()).toEqual({ requests: [] });
    expect(requests._rows[0].status).toBe('fulfilled');
  });

  it('dismiss: 404 unknown/settled, 403 for a non-admin, 200 flips pending', async () => {
    const seed: AccessRequestRow[] = [
      {
        id: 'req-1',
        groupName: 'GTM',
        requesterEmail: ALI,
        requesterName: 'Ali Baba',
        createdAt: new Date(1_700_000_000_000),
      },
    ];

    const stranger = await makeHarness({ requests: makeRequests(seed), email: 'nobody@bevel.software' });
    server = stranger.server;
    const missing = await fetch(`${stranger.baseUrl}/api/groups/access-requests/nope/dismiss`, {
      method: 'POST',
    });
    expect(missing.status).toBe(404);
    const forbidden = await fetch(`${stranger.baseUrl}/api/groups/access-requests/req-1/dismiss`, {
      method: 'POST',
    });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ error: 'Not allowed' });
    await close(stranger.server);

    const requests = makeRequests(seed);
    const admin = await makeHarness({
      requests,
      email: OLGA.email,
      writable: { [OLGA.email]: ['Groups/GTM'] },
    });
    server = admin.server;
    const ok = await fetch(`${admin.baseUrl}/api/groups/access-requests/req-1/dismiss`, { method: 'POST' });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
    expect(requests._rows[0].status).toBe('dismissed');
    // Settled now — a second dismiss is indistinguishable from never-pending.
    const again = await fetch(`${admin.baseUrl}/api/groups/access-requests/req-1/dismiss`, { method: 'POST' });
    expect(again.status).toBe(404);
  });
});
