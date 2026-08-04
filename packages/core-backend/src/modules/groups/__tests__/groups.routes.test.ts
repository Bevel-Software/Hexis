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
import type { GroupSummary, IGroupIndexService } from '../groups.contract.js';

/**
 * HTTP-level contract for `GET /api/groups`: the auth gate, the per-caller
 * verdicts, and above all the fail-closed enumeration — a group the caller can
 * neither read nor write must be ABSENT from the response, not present in a
 * degraded form.
 *
 * The group index is REAL over a temp KB (so the folder scan and the counts are
 * exercised end to end); access control is a stub, because what's under test
 * here is the route's use of it.
 */

const KB = 'knowledge-base';
const wsId = workspaceIdForBranch(DEFAULT_BRANCH);
const OLGA = { name: 'Olga Ivanova', email: 'olga@bevel.software' };
const ALI = 'ali@bevel.software';

const tmpDirs: string[] = [];

interface HarnessOpts {
  /** Folders (`Groups/GTM`) the given email may read. */
  readable?: Record<string, string[]>;
  /** Folders the given email may write `access.md` on. */
  writable?: Record<string, string[]>;
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
  app.use('/api', createGroupsRoutes(index, accessControl));

  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${addr.port}`, accessControl };
}

function close(s: Server): Promise<void> {
  return new Promise((resolve, reject) => s.close((e) => (e ? reject(e) : resolve())));
}

/** Both groups readable — the baseline for tests not about the filter itself. */
const READ_ALL = { [ALI]: ['Groups/GTM', 'Groups/Finance'] };

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

  it('401s when req.userEmail is absent', async () => {
    const h = await makeHarness({ email: null });
    server = h.server;
    const res = await fetch(`${h.baseUrl}/api/groups`);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthenticated' });
  });

  it('sorts by name and counts by groupOfPath (ungrouped items count nowhere)', async () => {
    const h = await makeHarness({
      readable: READ_ALL,
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
    expect(groups[0]).toMatchObject({ folders: ['Groups/Finance'], skillCount: 0, toolCount: 1 });
    expect(groups[1]).toMatchObject({ folders: ['Groups/GTM'], skillCount: 1, toolCount: 0 });
  });

  it('OMITS a group the caller can neither read nor write — nothing about it leaves the backend', async () => {
    const h = await makeHarness({ readable: { [ALI]: ['Groups/Finance'] } });
    server = h.server;
    const { status, groups, raw } = await listGroups(h.baseUrl);
    expect(status).toBe(200);
    expect(groups.map((g) => g.name)).toEqual(['Finance']);
    // Not merely unlisted: no entry for the hidden group exists in the payload
    // at all. (The listed group's own principals may of course mention a role
    // whose display name resembles it.)
    expect(raw).not.toContain('"name":"GTM"');
    expect(raw).not.toContain('Groups/GTM');
  });

  it('discloses full principals (emails included) on a readable group', async () => {
    const h = await makeHarness({ readable: { [ALI]: ['Groups/Finance'] } });
    server = h.server;
    const { groups } = await listGroups(h.baseUrl);
    const finance = groups[0];
    expect(finance.canRead).toBe(true);
    expect(finance.owners.users).toEqual([OLGA]);
    expect(finance.writers.roles).toEqual(['Admin']);
    expect(finance.readers).toEqual({ restricted: true, roles: ['GTM Team'], users: [OLGA] });
  });

  it('keeps a locked-out folder-writer\'s group listed with canWrite: true (admin-rescue)', async () => {
    const h = await makeHarness({ readable: { [ALI]: [] }, writable: { [ALI]: ['Groups/GTM'] } });
    server = h.server;
    const { groups } = await listGroups(h.baseUrl);
    expect(groups.map((g) => g.name)).toEqual(['GTM']);
    expect(groups[0]).toMatchObject({ canRead: false, canWrite: true });
  });

  it('serves { groups: [] } without consulting access control when no group folders exist', async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-groups-empty-'));
    tmpDirs.push(workspaceDir);
    await fs.mkdir(path.join(workspaceDir, KB), { recursive: true });
    const h = await makeHarness({
      index: new GroupIndexService(
        {
          getOrCreateForBranch: async () => ({ id: wsId }),
          getWorkspacePath: async () => workspaceDir,
        } as unknown as WorkspaceService,
        {} as IAccessControl,
        { listSkills: async () => [] } as unknown as ISkillService,
        { listAllSummaries: async () => [] } as unknown as IToolManualService,
        KB,
      ),
    });
    server = h.server;
    const { status, groups } = await listGroups(h.baseUrl);
    expect(status).toBe(200);
    expect(groups).toEqual([]);
    expect(h.accessControl.canReadBatch).not.toHaveBeenCalled();
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
