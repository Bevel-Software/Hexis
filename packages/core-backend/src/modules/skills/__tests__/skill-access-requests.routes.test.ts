import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { DEFAULT_BRANCH, joinBranchFor } from '@bevel-software/platform-shared';
import type { IWorkflowService } from '@bevel-software/platform-shared';

import { workspaceIdForBranch } from '../../../shared/workspace-id.js';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import type { IAccessControl } from '../../access/access-control.interface.js';
import type { JoinRequestsService } from '../../plugins/join-requests.service.js';
import type { ISkillService } from '../skills.contract.js';
import { createSkillAccessRequestRoutes } from '../skill-access-requests.routes.js';

/**
 * The branch probe behind an access request: the listing is used to PROVE a
 * branch absent before one is cut, so it must be the strict kind — a stale
 * list (a fetch that failed) proves nothing, and the route must stop rather
 * than write a proposal onto a branch it never confirmed.
 */

const KB = 'knowledge-base';
const wsId = workspaceIdForBranch(DEFAULT_BRANCH);
const MIA = { id: 'u-mia', email: 'mia@x.io', name: 'Mia' };
const FOLDER = 'Skills/Eng/deploy';

async function makeHarness(listBranches: IWorkflowService['listBranches']) {
  const workflow = {
    listChangeRequestsAuthoredBy: vi.fn(async () => []),
    listBranches: vi.fn(listBranches),
    createBranch: vi.fn(async () => ({ name: 'x', isDefault: false, isProtected: false })),
    commitChanges: vi.fn(async () => null),
    openChangeRequest: vi.fn(async () => ({ number: 42 })),
  } as unknown as IWorkflowService;
  const workspaceService = {
    getOrCreateForBranch: vi.fn(async (branch: string) => ({ id: workspaceIdForBranch(branch) })),
    readFile: vi.fn(async () => '---\n---\nwrite:\n  - Eve <eve@x.io>\n'),
    writeFile: vi.fn(async () => undefined),
  } as unknown as WorkspaceService;
  const accessControl = { canWrite: vi.fn(async () => false) } as unknown as IAccessControl;
  const skillService = {
    listSkills: vi.fn(async () => [{ name: 'deploy', description: '', path: FOLDER }]),
  } as unknown as ISkillService;

  const app = express();
  app.use(express.json());
  app.use(
    '/api',
    createSkillAccessRequestRoutes({
      skillService,
      accessControl,
      workflow,
      workspaceService,
      joinRequests: { list: vi.fn(), reconcile: vi.fn() } as unknown as JoinRequestsService,
      kbDirName: KB,
      resolveUser: async () => MIA,
    }),
  );
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}/api/skills/deploy/access-request`, workflow, workspaceService };
}

describe('POST /skills/:name/access-request — the branch probe', () => {
  let server: Server | null = null;
  afterEach(async () => {
    // Released here, not after the assertions: a failing assertion must not
    // leave the console muted for every test that follows.
    vi.restoreAllMocks();
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = null;
  });

  it('proves absence with a STRICT fresh listing, then cuts the branch and opens the request', async () => {
    const h = await makeHarness(async () => []);
    server = h.server;
    const res = await fetch(h.url, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, number: 42 });
    expect(h.workflow.listBranches).toHaveBeenCalledWith(wsId, { freshFetch: true, strictFetch: true });
    expect(h.workflow.createBranch).toHaveBeenCalledWith(wsId, joinBranchFor(MIA.email, FOLDER), DEFAULT_BRANCH);
    expect(h.workspaceService.writeFile).toHaveBeenCalledTimes(1);
  });

  it('a create that loses the race proceeds once the fresh re-probe shows the branch', async () => {
    const branch = joinBranchFor(MIA.email, FOLDER);
    // Absent on the first probe, present on the second: someone else cut it in between.
    let probes = 0;
    const h = await makeHarness(async () => (probes++ === 0 ? [] : [{ name: branch, isDefault: false, isProtected: false }]));
    (h.workflow.createBranch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('already exists'));
    server = h.server;
    const res = await fetch(h.url, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, number: 42 });
    expect(h.workflow.listBranches).toHaveBeenCalledTimes(2);
    expect(h.workspaceService.writeFile).toHaveBeenCalledTimes(1);
  });

  it('a create that fails with no branch to show for it stops the request — nothing is written on a branch that was not made', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = await makeHarness(async () => []);
    (h.workflow.createBranch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('origin refused'));
    server = h.server;
    const res = await fetch(h.url, { method: 'POST' });
    expect(res.status).toBe(500);
    expect(h.workflow.listBranches).toHaveBeenCalledTimes(2);
    expect(h.workspaceService.writeFile).not.toHaveBeenCalled();
    expect(h.workflow.openChangeRequest).not.toHaveBeenCalled();
  });

  it('a listing that could not prove anything stops the request before a branch or a byte is written', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = await makeHarness(async () => {
      throw new Error('the fetch from origin failed, so the branch list cannot prove absence');
    });
    server = h.server;
    const res = await fetch(h.url, { method: 'POST' });
    expect(res.status).toBe(500);
    expect(h.workflow.createBranch).not.toHaveBeenCalled();
    expect(h.workspaceService.writeFile).not.toHaveBeenCalled();
    expect(h.workflow.openChangeRequest).not.toHaveBeenCalled();
  });
});
