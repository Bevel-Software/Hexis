import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import { describe, it, expect, afterEach, vi } from 'vitest';

import { DEFAULT_BRANCH, joinBranchFor } from '@bevel-software/platform-shared';
import type { ChangeRequest, IWorkflowService } from '@bevel-software/platform-shared';
import { workspaceIdForBranch } from '../../workspace/workspace.service.js';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import type { IAccessControl } from '../../access/access-control.interface.js';
import type { ISkillService, SkillSummary } from '../../skills/skills.contract.js';
import type { IToolManualService, ToolManualSummary } from '../../tool-manuals/tool-manuals.contract.js';
import { GroupIndexService } from '../groups.service.js';
import { createGroupsRoutes } from '../groups.routes.js';
import type { GroupSummary, IGroupIndexService } from '../groups.contract.js';

/**
 * HTTP-level contract for the group routes: the auth gate, the three-tier
 * enumeration (member / manager / discoverable — all ordinary access
 * verdicts), the fail-closed omission of groups with no verdict at all, and
 * the join flow that rides on plain change requests.
 *
 * The group index is REAL over a temp KB; access control and the workflow are
 * stubs, because what's under test here is the route's use of them.
 */

const KB = 'knowledge-base';
const wsId = workspaceIdForBranch(DEFAULT_BRANCH);
const OLGA = { name: 'Olga Ivanova', email: 'olga@bevel.software' };
const ALI = 'ali@bevel.software';
const ALI_USER = { id: 'u-1', email: ALI, name: 'Ali Baba' };

const tmpDirs: string[] = [];

interface HarnessOpts {
  /**
   * Paths (`Groups/GTM` for the folder/member verdict, `Groups/GTM/access.md`
   * for the discover verdict) the given email may read.
   */
  readable?: Record<string, string[]>;
  /** Paths the given email may write. */
  writable?: Record<string, string[]>;
  /** Open CRs `listChangeRequestsAuthoredBy` returns for any caller. */
  authoredCrs?: ChangeRequest[];
  /** Override the whole index (used to force the 500 path). */
  index?: IGroupIndexService;
  email?: string | null;
  skills?: SkillSummary[];
  tools?: ToolManualSummary[];
}

function cr(over: Partial<ChangeRequest>): ChangeRequest {
  return {
    number: 7,
    title: 'Join request: GTM',
    author: { login: 'svc' },
    branch: joinBranchFor(ALI, 'GTM'),
    base: DEFAULT_BRANCH,
    state: 'open',
    createdAt: '2026-01-01T00:00:00.000Z',
    touchedNodePaths: [],
    review: { state: 'none' },
    url: 'https://example.com/pr/7',
    ...over,
  } as ChangeRequest;
}

async function makeHarness(opts: HarnessOpts = {}) {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-groups-routes-'));
  tmpDirs.push(workspaceDir);
  const kbRoot = path.join(workspaceDir, KB);
  await fs.mkdir(path.join(kbRoot, 'Groups', 'GTM'), { recursive: true });
  await fs.mkdir(path.join(kbRoot, 'Groups', 'Finance'), { recursive: true });
  await fs.writeFile(
    path.join(kbRoot, 'Groups', 'Finance', 'access.md'),
    '---\nread:\n  - everyone\n---\nread: []\n',
  );

  const workspaceService = {
    getOrCreateForBranch: async (branch: string) => ({ id: workspaceIdForBranch(branch) }),
    getWorkspacePath: async () => workspaceDir,
    readFile: vi.fn(async () => '---\nread:\n  - everyone\n---\nread: []\n'),
    writeFile: vi.fn(async () => undefined),
  } as unknown as WorkspaceService;

  const verdictFor = (table: Record<string, string[]> | undefined, email: string, paths: string[]) =>
    new Map(paths.map((p) => [p, (table?.[email] ?? []).includes(p)]));

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

  const workflow = {
    listChangeRequestsAuthoredBy: vi.fn(async () => opts.authoredCrs ?? []),
    createBranch: vi.fn(async () => ({ name: 'x', isDefault: false, isProtected: false })),
    commitChanges: vi.fn(async () => null),
    openChangeRequest: vi.fn(async () => ({ number: 42 })),
  } as unknown as IWorkflowService;

  const skillService = { listSkills: async () => opts.skills ?? [] } as unknown as ISkillService;
  const toolService = {
    listAllSummaries: async () => opts.tools ?? [],
  } as unknown as IToolManualService;

  const index =
    opts.index ??
    new GroupIndexService(workspaceService, accessControl, skillService, toolService, KB);

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
    createGroupsRoutes(index, accessControl, workflow, workspaceService, KB, async (req) =>
      req.userEmail ? { ...ALI_USER, email: req.userEmail } : null,
    ),
  );

  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${addr.port}`, accessControl, workflow, workspaceService };
}

function close(s: Server): Promise<void> {
  return new Promise((resolve, reject) => s.close((e) => (e ? reject(e) : resolve())));
}

const MEMBER_OF_BOTH = {
  [ALI]: ['Groups/GTM', 'Groups/GTM/access.md', 'Groups/Finance', 'Groups/Finance/access.md'],
};

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
    return { status: res.status, groups: body.groups, raw: JSON.stringify(body) };
  };

  it('401s both endpoints when req.userEmail is absent', async () => {
    const h = await makeHarness({ email: null });
    server = h.server;
    for (const [method, url] of [
      ['GET', '/api/groups'],
      ['POST', '/api/groups/GTM/join-request'],
    ] as const) {
      const res = await fetch(`${h.baseUrl}${url}`, { method });
      expect(res.status, `${method} ${url}`).toBe(401);
    }
  });

  it('lists member groups sorted, counting by groupOfPath', async () => {
    const h = await makeHarness({
      readable: MEMBER_OF_BOTH,
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
    expect(groups[0]).toMatchObject({ canRead: true, skillCount: 0, toolCount: 1 });
    expect(groups[1]).toMatchObject({ canRead: true, skillCount: 1, toolCount: 0 });
  });

  it('a DISCOVERABLE group (access.md readable, folder not) lists locked with hasRequested from the join CR', async () => {
    const h = await makeHarness({
      readable: { [ALI]: ['Groups/Finance/access.md'] },
      authoredCrs: [cr({ branch: joinBranchFor(ALI, 'Finance'), number: 9 })],
    });
    server = h.server;
    const { groups } = await listGroups(h.baseUrl);
    expect(groups.map((g) => g.name)).toEqual(['Finance']);
    expect(groups[0]).toMatchObject({
      canRead: false,
      canWrite: false,
      hasRequested: true,
      requestNumber: 9,
    });
  });

  it('OMITS a group with NO verdict at all — nothing about it leaves the backend', async () => {
    const h = await makeHarness({ readable: { [ALI]: ['Groups/Finance/access.md'] } });
    server = h.server;
    const { groups, raw } = await listGroups(h.baseUrl);
    expect(groups.map((g) => g.name)).toEqual(['Finance']);
    expect(raw).not.toContain('"name":"GTM"');
    expect(raw).not.toContain('Groups/GTM');
  });

  it("keeps a locked-out folder-writer's group listed with canWrite: true (admin-rescue)", async () => {
    const h = await makeHarness({ writable: { [ALI]: ['Groups/GTM/access.md'] } });
    server = h.server;
    const { groups } = await listGroups(h.baseUrl);
    expect(groups.map((g) => g.name)).toEqual(['GTM']);
    expect(groups[0]).toMatchObject({ canRead: false, canWrite: true });
  });

  it('a member never reports hasRequested (their stale join CR is ignored)', async () => {
    const h = await makeHarness({
      readable: { [ALI]: ['Groups/GTM', 'Groups/GTM/access.md'] },
      authoredCrs: [cr({})],
    });
    server = h.server;
    const { groups } = await listGroups(h.baseUrl);
    expect(groups[0]).toMatchObject({ name: 'GTM', canRead: true, hasRequested: false });
  });

  it('join-request: 404 for unknown AND for undiscoverable (identical, fail-closed)', async () => {
    const h = await makeHarness({});
    server = h.server;
    for (const name of ['Nope', 'GTM']) {
      const res = await fetch(`${h.baseUrl}/api/groups/${name}/join-request`, { method: 'POST' });
      expect(res.status, name).toBe(404);
      expect(await res.json()).toEqual({ error: 'Unknown group', kind: 'unknown-group' });
    }
  });

  it('join-request: 409 when the caller can already read the folder', async () => {
    const h = await makeHarness({ readable: MEMBER_OF_BOTH });
    server = h.server;
    const res = await fetch(`${h.baseUrl}/api/groups/Finance/join-request`, { method: 'POST' });
    expect(res.status).toBe(409);
    expect((await res.json()).kind).toBe('already-readable');
  });

  it('join-request: branch + splice + commit + CR, on the deterministic join branch', async () => {
    const h = await makeHarness({ readable: { [ALI]: ['Groups/Finance/access.md'] } });
    server = h.server;
    const res = await fetch(`${h.baseUrl}/api/groups/Finance/join-request`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, number: 42 });

    const branch = joinBranchFor(ALI, 'Finance');
    expect(h.workflow.createBranch).toHaveBeenCalledWith(wsId, branch, DEFAULT_BRANCH);
    // The write went to the group's access.md and added the caller to the
    // BODY's read list (folder rules), leaving the discovery frontmatter alone.
    const write = (h.workspaceService.writeFile as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(write[1]).toBe(`${KB}/Groups/Finance/access.md`);
    expect(write[2]).toContain('Ali Baba <ali@bevel.software>');
    expect((write[2] as string).indexOf('everyone')).toBeLessThan(
      (write[2] as string).indexOf('Ali Baba'),
    );
    expect(h.workflow.commitChanges).toHaveBeenCalled();
    expect(h.workflow.openChangeRequest).toHaveBeenCalledWith(
      workspaceIdForBranch(branch),
      expect.objectContaining({ email: ALI }),
      expect.objectContaining({
        sourceBranch: branch,
        targetBranch: DEFAULT_BRANCH,
        title: 'Join request: Finance',
      }),
    );
  });

  it('join-request is idempotent: an existing open join CR is returned, nothing new is created', async () => {
    const h = await makeHarness({
      readable: { [ALI]: ['Groups/Finance/access.md'] },
      authoredCrs: [cr({ branch: joinBranchFor(ALI, 'Finance'), number: 9 })],
    });
    server = h.server;
    const res = await fetch(`${h.baseUrl}/api/groups/Finance/join-request`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, number: 9 });
    expect(h.workflow.createBranch).not.toHaveBeenCalled();
    expect(h.workflow.openChangeRequest).not.toHaveBeenCalled();
  });

  it('degrades hasRequested to false when the CR lookup throws', async () => {
    const h = await makeHarness({ readable: { [ALI]: ['Groups/Finance/access.md'] } });
    (h.workflow.listChangeRequestsAuthoredBy as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('gh down'),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    server = h.server;
    const { status, groups } = await listGroups(h.baseUrl);
    expect(status).toBe(200);
    expect(groups[0]).toMatchObject({ hasRequested: false });
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
});
