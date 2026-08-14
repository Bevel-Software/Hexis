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
import { PluginIndexService } from '../plugins.service.js';
import { createPluginsRoutes } from '../plugins.routes.js';
import type { JoinRequestsService } from '../join-requests.service.js';
import type { PluginSummary, IPluginIndexService } from '../plugins.contract.js';

/**
 * HTTP-level contract for the plugin routes: the auth gate, the three-tier
 * enumeration (member / manager / discoverable — all ordinary access
 * verdicts), the fail-closed omission of plugins with no verdict at all, and
 * the join flow that rides on plain change requests.
 *
 * The plugin index is REAL over a temp KB; access control and the workflow are
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
   * Paths (`Plugins/GTM` for the folder/member verdict, `Plugins/GTM/access.md`
   * for the discover verdict) the given email may read.
   */
  readable?: Record<string, string[]>;
  /** Paths the given email may write. */
  writable?: Record<string, string[]>;
  /** Paths (the FOLDER, e.g. `Plugins/GTM`) the given email OWNS. */
  owner?: Record<string, string[]>;
  /** Open CRs `listChangeRequestsAuthoredBy` returns for any caller. */
  authoredCrs?: ChangeRequest[];
  /** Override the whole index (used to force the 500 path). */
  index?: IPluginIndexService;
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
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-plugins-routes-'));
  tmpDirs.push(workspaceDir);
  const kbRoot = path.join(workspaceDir, KB);
  // Both carry the access.md that makes a folder a plugin at all.
  await fs.mkdir(path.join(kbRoot, 'Plugins', 'GTM'), { recursive: true });
  await fs.writeFile(
    path.join(kbRoot, 'Plugins', 'GTM', 'access.md'),
    '---\nread:\n  - everyone\n---\nread: []\n',
  );
  await fs.mkdir(path.join(kbRoot, 'Plugins', 'Finance'), { recursive: true });
  await fs.writeFile(
    path.join(kbRoot, 'Plugins', 'Finance', 'access.md'),
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
    canOwnerBatch: vi.fn(async (_w: string, email: string, paths: string[]) =>
      verdictFor(opts.owner, email, paths),
    ),
    canOwner: vi.fn(async (_w: string, email: string, p: string) =>
      (opts.owner?.[email] ?? []).includes(p),
    ),
    eligibleOwners: async () => ({ roles: [], users: [OLGA] }),
    eligibleWriters: async () => ({ roles: ['Admin'], users: [] }),
    eligibleReaders: async () => ({ restricted: true, roles: ['GTM Team'], users: [OLGA] }),
  } as unknown as IAccessControl;

  const workflow = {
    listChangeRequestsAuthoredBy: vi.fn(async () => opts.authoredCrs ?? []),
    listChangeRequests: vi.fn(async () => opts.authoredCrs ?? []),
    getChangeRequest: vi.fn(
      async (n: number) => (opts.authoredCrs ?? []).find((c) => c.number === n) ?? null,
    ),
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
    new PluginIndexService(workspaceService, accessControl, skillService, toolService, KB);

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
  const joinRequests = {
    list: vi.fn(async () => []),
    reconcile: vi.fn(async () => false),
  } as unknown as JoinRequestsService;

  // Provisioning MECHANISM is exercised by its own service tests; the routes
  // here only need to prove what they hand it and when they refuse to.
  const provision = {
    createPlugin: vi.fn(async () => ({ folder: 'GTM', created: true })),
    deletePlugin: vi.fn(async () => undefined),
  };

  app.use(
    '/api',
    createPluginsRoutes(
      index,
      accessControl,
      workflow,
      workspaceService,
      joinRequests,
      provision as never,
      KB,
      async (req) => (req.userEmail ? { ...ALI_USER, email: req.userEmail } : null),
    ),
  );

  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address() as AddressInfo;
  return {
    server,
    baseUrl: `http://127.0.0.1:${addr.port}`,
    accessControl,
    workflow,
    workspaceService,
    joinRequests,
    provision,
  };
}

function close(s: Server): Promise<void> {
  return new Promise((resolve, reject) => s.close((e) => (e ? reject(e) : resolve())));
}

const MEMBER_OF_BOTH = {
  [ALI]: ['Plugins/GTM', 'Plugins/GTM/access.md', 'Plugins/Finance', 'Plugins/Finance/access.md'],
};

describe('/api/plugins routes', () => {
  let server: Server | null = null;
  afterEach(async () => {
    if (server) await close(server);
    server = null;
    await Promise.all(tmpDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  const listPlugins = async (baseUrl: string) => {
    const res = await fetch(`${baseUrl}/api/plugins`);
    const body = (await res.json()) as { plugins: PluginSummary[] };
    return { status: res.status, plugins: body.plugins, raw: JSON.stringify(body) };
  };

  it('401s both endpoints when req.userEmail is absent', async () => {
    const h = await makeHarness({ email: null });
    server = h.server;
    for (const [method, url] of [
      ['GET', '/api/plugins'],
      ['POST', '/api/plugins/GTM/join-request'],
      ['DELETE', '/api/plugins/GTM'],
    ] as const) {
      const res = await fetch(`${h.baseUrl}${url}`, { method });
      expect(res.status, `${method} ${url}`).toBe(401);
    }
  });

  it('lists member plugins sorted, counting by pluginOfPath', async () => {
    const h = await makeHarness({
      readable: MEMBER_OF_BOTH,
      skills: [{ name: 'outreach', description: '', path: 'Plugins/GTM/outreach' }],
      tools: [
        { slug: 'ledger', name: 'ledger', path: 'Plugins/Finance/ledger.tool', type: 'inline' },
        { slug: 'slack', name: 'slack', path: 'Plugins/slack.tool', type: 'inline' },
      ],
    });
    server = h.server;
    const { status, plugins } = await listPlugins(h.baseUrl);
    expect(status).toBe(200);
    expect(plugins.map((g) => g.name)).toEqual(['Finance', 'GTM']);
    expect(plugins[0]).toMatchObject({ canRead: true, skillCount: 0, toolCount: 1 });
    expect(plugins[1]).toMatchObject({ canRead: true, skillCount: 1, toolCount: 0 });
  });

  it('a DISCOVERABLE plugin (access.md readable, folder not) lists locked with hasRequested from the join CR', async () => {
    const h = await makeHarness({
      readable: { [ALI]: ['Plugins/Finance/access.md'] },
      authoredCrs: [cr({ branch: joinBranchFor(ALI, 'Finance'), number: 9 })],
    });
    server = h.server;
    const { plugins } = await listPlugins(h.baseUrl);
    expect(plugins.map((g) => g.name)).toEqual(['Finance']);
    expect(plugins[0]).toMatchObject({
      canRead: false,
      canWrite: false,
      hasRequested: true,
      requestNumber: 9,
    });
  });

  it('OMITS a plugin with NO verdict at all — nothing about it leaves the backend', async () => {
    const h = await makeHarness({ readable: { [ALI]: ['Plugins/Finance/access.md'] } });
    server = h.server;
    const { plugins, raw } = await listPlugins(h.baseUrl);
    expect(plugins.map((g) => g.name)).toEqual(['Finance']);
    expect(raw).not.toContain('"name":"GTM"');
    expect(raw).not.toContain('Plugins/GTM');
  });

  it("keeps a locked-out folder-writer's plugin listed with canWrite: true (admin-rescue)", async () => {
    const h = await makeHarness({ writable: { [ALI]: ['Plugins/GTM/access.md'] } });
    server = h.server;
    const { plugins } = await listPlugins(h.baseUrl);
    expect(plugins.map((g) => g.name)).toEqual(['GTM']);
    expect(plugins[0]).toMatchObject({ canRead: false, canWrite: true });
  });

  it('a member never reports hasRequested (their stale join CR is ignored)', async () => {
    const h = await makeHarness({
      readable: { [ALI]: ['Plugins/GTM', 'Plugins/GTM/access.md'] },
      authoredCrs: [cr({})],
    });
    server = h.server;
    const { plugins } = await listPlugins(h.baseUrl);
    expect(plugins[0]).toMatchObject({ name: 'GTM', canRead: true, hasRequested: false });
  });

  it('lists the owner verdict per caller — the folder verdict, not the manager one', async () => {
    const h = await makeHarness({
      readable: MEMBER_OF_BOTH,
      owner: { [ALI]: ['Plugins/GTM'] },
    });
    server = h.server;
    const { plugins } = await listPlugins(h.baseUrl);
    expect(plugins.find((g) => g.name === 'GTM')).toMatchObject({ isOwner: true });
    expect(plugins.find((g) => g.name === 'Finance')).toMatchObject({ isOwner: false });
  });

  it('delete: 404 for unknown AND for a non-owner — a manager included (identical, fail-closed)', async () => {
    // A MANAGER (write on the access.md) and a MEMBER, but not an owner:
    // deletion is the owner's verb, and the refusal must not confirm the
    // plugin exists.
    const h = await makeHarness({
      readable: MEMBER_OF_BOTH,
      writable: { [ALI]: ['Plugins/GTM/access.md'] },
    });
    server = h.server;
    for (const name of ['Nope', 'GTM']) {
      const res = await fetch(`${h.baseUrl}/api/plugins/${name}`, { method: 'DELETE' });
      expect(res.status, name).toBe(404);
      expect(await res.json()).toEqual({ error: 'Unknown plugin', kind: 'unknown-plugin' });
    }
    expect(h.provision.deletePlugin).not.toHaveBeenCalled();
  });

  it('delete: an OWNER deletes through the provision door, by the catalog name', async () => {
    const h = await makeHarness({ owner: { [ALI]: ['Plugins/GTM'] } });
    server = h.server;
    const res = await fetch(`${h.baseUrl}/api/plugins/GTM`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(h.provision.deletePlugin).toHaveBeenCalledWith(
      expect.objectContaining({ email: ALI }),
      'GTM',
    );
  });

  it("delete: passes a provision refusal through with the service's own status and words", async () => {
    const h = await makeHarness({ owner: { [ALI]: ['Plugins/GTM'] } });
    const { PluginProvisionError } = await import('../plugin-provision.service.js');
    h.provision.deletePlugin.mockRejectedValueOnce(new PluginProvisionError('Unknown plugin', 404));
    server = h.server;
    const res = await fetch(`${h.baseUrl}/api/plugins/GTM`, { method: 'DELETE' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Unknown plugin' });
  });

  it('delete: 500s with its own words when the mechanism fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = await makeHarness({ owner: { [ALI]: ['Plugins/GTM'] } });
    h.provision.deletePlugin.mockRejectedValueOnce(new Error('push refused'));
    server = h.server;
    const res = await fetch(`${h.baseUrl}/api/plugins/GTM`, { method: 'DELETE' });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to delete the plugin' });
    error.mockRestore();
  });

  it('join-request: 404 for unknown AND for undiscoverable (identical, fail-closed)', async () => {
    const h = await makeHarness({});
    server = h.server;
    for (const name of ['Nope', 'GTM']) {
      const res = await fetch(`${h.baseUrl}/api/plugins/${name}/join-request`, { method: 'POST' });
      expect(res.status, name).toBe(404);
      expect(await res.json()).toEqual({ error: 'Unknown plugin', kind: 'unknown-plugin' });
    }
  });

  it('join-request: 409 when the caller can already read the folder', async () => {
    const h = await makeHarness({ readable: MEMBER_OF_BOTH });
    server = h.server;
    const res = await fetch(`${h.baseUrl}/api/plugins/Finance/join-request`, { method: 'POST' });
    expect(res.status).toBe(409);
    expect((await res.json()).kind).toBe('already-readable');
  });

  it('join-request: branch + splice + commit + CR, on the deterministic join branch', async () => {
    const h = await makeHarness({ readable: { [ALI]: ['Plugins/Finance/access.md'] } });
    server = h.server;
    const res = await fetch(`${h.baseUrl}/api/plugins/Finance/join-request`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, number: 42 });

    const branch = joinBranchFor(ALI, 'Finance');
    expect(h.workflow.createBranch).toHaveBeenCalledWith(wsId, branch, DEFAULT_BRANCH);
    // The write went to the plugin's access.md and added the caller to the
    // BODY's read list (folder rules), leaving the discovery frontmatter alone.
    const write = (h.workspaceService.writeFile as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(write[1]).toBe(`${KB}/Plugins/Finance/access.md`);
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
      readable: { [ALI]: ['Plugins/Finance/access.md'] },
      authoredCrs: [cr({ branch: joinBranchFor(ALI, 'Finance'), number: 9 })],
    });
    server = h.server;
    const res = await fetch(`${h.baseUrl}/api/plugins/Finance/join-request`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, number: 9 });
    expect(h.workflow.createBranch).not.toHaveBeenCalled();
    expect(h.workflow.openChangeRequest).not.toHaveBeenCalled();
  });

  it('degrades hasRequested to false when the CR lookup throws', async () => {
    const h = await makeHarness({ readable: { [ALI]: ['Plugins/Finance/access.md'] } });
    (h.workflow.listChangeRequestsAuthoredBy as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('gh down'),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    server = h.server;
    const { status, plugins } = await listPlugins(h.baseUrl);
    expect(status).toBe(200);
    expect(plugins[0]).toMatchObject({ hasRequested: false });
    warn.mockRestore();
  });

  it('join-requests: a MANAGER gets the service\'s list for the plugin', async () => {
    const h = await makeHarness({ writable: { [ALI]: ['Plugins/GTM/access.md'] } });
    server = h.server;
    const res = await fetch(`${h.baseUrl}/api/plugins/GTM/join-requests`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ requests: [] });
    expect(h.joinRequests.list).toHaveBeenCalledWith(
      'GTM',
      'Plugins/GTM',
      expect.anything(),
      expect.objectContaining({ email: ALI }),
    );
  });

  it('join-requests: a NON-manager gets [] rather than a 403, and the service is never asked', async () => {
    // The frontend asks unconditionally; "am I a manager here" stays a
    // question only the server answers.
    const h = await makeHarness({ readable: MEMBER_OF_BOTH });
    server = h.server;
    const res = await fetch(`${h.baseUrl}/api/plugins/GTM/join-requests`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ requests: [] });
    expect(h.joinRequests.list).not.toHaveBeenCalled();
  });

  it('reconcile: 404 for a non-manager — indistinguishable from a missing request', async () => {
    const h = await makeHarness({ readable: MEMBER_OF_BOTH, authoredCrs: [cr({ number: 7 })] });
    server = h.server;
    const denied = await fetch(`${h.baseUrl}/api/plugins/GTM/join-requests/7/reconcile`, {
      method: 'POST',
    });
    expect(denied.status).toBe(404);
    expect(h.joinRequests.reconcile).not.toHaveBeenCalled();
  });

  it('reconcile: 404 for a manager when the change request does not exist', async () => {
    const h = await makeHarness({ writable: { [ALI]: ['Plugins/GTM/access.md'] } });
    server = h.server;
    const missing = await fetch(`${h.baseUrl}/api/plugins/GTM/join-requests/999/reconcile`, {
      method: 'POST',
    });
    expect(missing.status).toBe(404);
    expect(h.joinRequests.reconcile).not.toHaveBeenCalled();
  });

  it('reconcile: a manager settles an open request through the service', async () => {
    const h = await makeHarness({
      writable: { [ALI]: ['Plugins/GTM/access.md'] },
      authoredCrs: [cr({ number: 7 })],
    });
    (h.joinRequests.reconcile as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    server = h.server;
    const res = await fetch(`${h.baseUrl}/api/plugins/GTM/join-requests/7/reconcile`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ closed: true });
  });

  it('500s with { error: "Failed to list plugins" } when the index throws', async () => {
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
    const res = await fetch(`${h.baseUrl}/api/plugins`);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to list plugins' });
    error.mockRestore();
  });
});
