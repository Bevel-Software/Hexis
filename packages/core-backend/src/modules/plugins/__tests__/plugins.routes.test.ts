import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { NodeFs } from '../../kb-fs/node-fs.js';
import { KbPluginSource } from '../discovery/kb-plugin-source.js';

import { DEFAULT_BRANCH, joinBranchFor } from '@bevel-software/platform-shared';
import type { ChangeRequest, IWorkflowService } from '@bevel-software/platform-shared';
import { workspaceIdForBranch } from '../../../shared/workspace-id.js';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import type { IAccessControl } from '../../access/access-control.interface.js';
import type { ISkillService, SkillSummary } from '../../skills/skills.contract.js';
import type { IToolManualService, ToolManualSummary } from '../../tool-manuals/tool-manuals.contract.js';
import { PluginIndexService } from '../plugins.service.js';
import { createPluginCreationRoutes, createPluginsRoutes } from '../plugins.routes.js';
import type { JoinRequestsService } from '../join-requests.service.js';
import { PluginJoinRequestJobs } from '../join-request-jobs.service.js';
import { pluginFolderBelowRoot } from '../plugins.service.js';
import { FakeJoinRequestStore } from './fake-join-request-store.js';
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
  /** More plugins: folder path below `Plugins/` → manifest name. */
  extraPlugins?: Record<string, string>;
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
  // Both carry the manifest that makes a folder a plugin to discovery, and
  // the access.md that makes it exist to the index.
  // Folder, identity, display name. GTM's three spellings are deliberately
  // all different: nothing here may read the folder for either name, and a
  // fixture whose displayName echoed its folder could not tell the two apart.
  const fixtures: [string, string, string][] = [
    ['GTM', 'gtm', 'Google Tag Manager'],
    ['Finance', 'finance', 'Finance'],
    ...Object.entries(opts.extraPlugins ?? {}).map(
      ([folder, name]): [string, string, string] => [folder, name, folder],
    ),
  ];
  for (const [folder, name, displayName] of fixtures) {
    await fs.mkdir(path.join(kbRoot, 'Plugins', folder), { recursive: true });
    // Both names in the file, as every manifest carries them: the identity
    // and the spelling people see. Nothing reads the folder for either.
    await fs.writeFile(
      path.join(kbRoot, 'Plugins', folder, 'plugin.json'),
      `{"name":"${name}","displayName":"${displayName}"}`,
    );
    await fs.writeFile(
      path.join(kbRoot, 'Plugins', folder, 'access.md'),
      '---\nread:\n  - everyone\n---\nread: []\n',
    );
  }

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
    listBranches: vi.fn(async () => []),
    commitChanges: vi.fn(async () => null),
    openChangeRequest: vi.fn(async () => ({ number: 42 })),
  } as unknown as IWorkflowService;

  const skillService = { listSkills: async () => opts.skills ?? [] } as unknown as ISkillService;
  const toolService = {
    listAllSummaries: async () => opts.tools ?? [],
  } as unknown as IToolManualService;

  const index =
    opts.index ??
    new PluginIndexService(workspaceService, accessControl, skillService, toolService, KB, new KbPluginSource(new NodeFs()));

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

  // The records half is REAL over an in-memory table, because the route's
  // whole contract now is "write a row, answer, then do the git" — a stub
  // would assert the route called something, not that the row and the change
  // request are one-to-one. The git it eventually does is the workflow stub
  // above, as it always was.
  const joinRequestStore = new FakeJoinRequestStore();
  // The change requests the store can see are the ones the listing is told
  // about, state and all — so a test that lists a closed request is also
  // telling the record it names that the request is over.
  for (const c of opts.authoredCrs ?? []) joinRequestStore.changeRequests.set(c.number, c.state);
  const joinRequestJobs = new PluginJoinRequestJobs(joinRequestStore, {
    workflow,
    workspaceService,
    kbDirName: KB,
    target: async (pluginKey) => {
      const entry = (await index.catalog()).find(
        (g) => pluginFolderBelowRoot(g.folders[0]) === pluginKey,
      );
      return entry ? { folder: entry.folders[0], displayName: entry.displayName } : null;
    },
    requester: async (mail) => ({ ...ALI_USER, email: mail }),
  });

  // Provisioning MECHANISM is exercised by its own service tests; the routes
  // here only need to prove what they hand it and when they refuse to.
  const provision = {
    createPlugin: vi.fn(async () => ({ folder: 'GTM', created: true })),
    ensurePersonalPlugin: vi.fn(async () => ({ folder: 'personal-u-1', created: false })),
    deletePlugin: vi.fn(async () => undefined),
  };

  // The creation doors are their own router in the server (behind the
  // key-or-session gate); here they share the fake identity middleware.
  app.use(
    '/api',
    createPluginCreationRoutes(provision as never, async (req) =>
      req.userEmail ? { ...ALI_USER, email: req.userEmail } : null,
    ),
  );
  app.use(
    '/api',
    createPluginsRoutes(
      index,
      accessControl,
      workflow,
      joinRequests,
      joinRequestJobs,
      provision as never,
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
    joinRequestJobs,
    joinRequestStore,
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

  it('POST /plugins hands the service the name and, when given, the grouping folder to make it in', async () => {
    const h = await makeHarness();
    server = h.server;
    const post = (body: unknown) =>
      fetch(`${h.baseUrl}/api/plugins`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    expect((await post({ name: 'Sales' })).status).toBe(201);
    expect(h.provision.createPlugin).toHaveBeenLastCalledWith(expect.objectContaining({ email: ALI }), 'Sales', undefined);
    expect((await post({ name: 'Sales', parent: 'Teams/EU' })).status).toBe(201);
    expect(h.provision.createPlugin).toHaveBeenLastCalledWith(expect.anything(), 'Sales', 'Teams/EU');
    // A parent that is not a string is a bad request, not a service error.
    expect((await post({ name: 'Sales', parent: 7 })).status).toBe(400);
    expect(h.provision.createPlugin).toHaveBeenCalledTimes(2);
  });

  it('POST /plugins/personal ensures the caller’s own space and returns it; no caller, no space', async () => {
    const h = await makeHarness();
    server = h.server;
    const res = await fetch(`${h.baseUrl}/api/plugins/personal`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ folder: 'personal-u-1', created: false });
    expect(h.provision.ensurePersonalPlugin).toHaveBeenCalledWith(expect.objectContaining({ email: ALI }));

    const anon = await makeHarness({ email: null });
    try {
      expect((await fetch(`${anon.baseUrl}/api/plugins/personal`, { method: 'POST' })).status).toBe(401);
      expect(anon.provision.ensurePersonalPlugin).not.toHaveBeenCalled();
    } finally {
      await close(anon.server);
    }
  });

  it("POST /plugins/personal keeps the service's own status — a 503 for incomplete discovery is retryable, not a 500", async () => {
    const h = await makeHarness();
    server = h.server;
    const { PluginProvisionError } = await import('../plugin-provision.service.js');
    h.provision.ensurePersonalPlugin.mockRejectedValueOnce(new PluginProvisionError('Plugin discovery is incomplete', 503));
    const res = await fetch(`${h.baseUrl}/api/plugins/personal`, { method: 'POST' });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Plugin discovery is incomplete' });
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
    // Named by identity and labelled by display name — both the manifest's.
    expect(plugins.map((g) => [g.name, g.displayName])).toEqual([
      ['finance', 'Finance'],
      ['gtm', 'Google Tag Manager'],
    ]);
    // `linkedRoots` is part of the summary's contract — the plugin page reads
    // it to name where a linked card lives. Neither fixture links anything,
    // and an empty list is what says so; a dropped mapping would be `undefined`.
    expect(plugins[0]).toMatchObject({ canRead: true, skillCount: 0, toolCount: 1, linkedRoots: [] });
    expect(plugins[1]).toMatchObject({ canRead: true, skillCount: 1, toolCount: 0, linkedRoots: [] });
  });

  it("carries the index's broken-link count into the summary — the server's, not the caller's slice", async () => {
    const entry = {
      name: 'gtm',
      displayName: 'GTM',
      folders: ['Plugins/GTM'],
      linkedRoots: ['Skills/Testing'],
      linksAreManaged: true,
      skillCount: 2,
      toolCount: 0,
      brokenLinks: 2,
      owners: { roles: [], users: [] },
      writers: { roles: [], users: [] },
      readers: { restricted: true, roles: [], users: [] },
      isPrivate: false,
      warnings: ['mcpProfile "global" named but no registry could be read'],
    };
    const h = await makeHarness({
      readable: MEMBER_OF_BOTH,
      index: { catalog: async () => [entry], invalidate: () => {} } as unknown as IPluginIndexService,
    });
    server = h.server;
    const { plugins } = await listPlugins(h.baseUrl);
    expect(plugins).toHaveLength(1);
    expect(plugins[0]).toMatchObject({
      name: 'gtm',
      brokenLinks: 2,
      // The roots the index scanned reach the page, which needs them to say
      // where a linked card lives.
      linkedRoots: ['Skills/Testing'],
      // What discovery left out reaches the summary as the index said it.
      warnings: ['mcpProfile "global" named but no registry could be read'],
    });
  });

  it('a DISCOVERABLE plugin (access.md readable, folder not) lists locked with hasRequested from the join CR', async () => {
    const h = await makeHarness({
      readable: { [ALI]: ['Plugins/Finance/access.md'] },
      authoredCrs: [cr({ branch: joinBranchFor(ALI, 'Finance'), number: 9 })],
    });
    server = h.server;
    const { plugins } = await listPlugins(h.baseUrl);
    expect(plugins.map((g) => g.name)).toEqual(['finance']);
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
    expect(plugins.map((g) => g.name)).toEqual(['finance']);
    expect(raw).not.toContain('"name":"gtm"');
    expect(raw).not.toContain('"GTM"');
    expect(raw).not.toContain('Plugins/GTM');
  });

  it("keeps a locked-out folder-writer's plugin listed with canWrite: true (admin-rescue)", async () => {
    const h = await makeHarness({ writable: { [ALI]: ['Plugins/GTM/access.md'] } });
    server = h.server;
    const { plugins } = await listPlugins(h.baseUrl);
    expect(plugins.map((g) => g.name)).toEqual(['gtm']);
    expect(plugins[0]).toMatchObject({ canRead: false, canWrite: true });
  });

  it('a member never reports hasRequested (their stale join CR is ignored)', async () => {
    const h = await makeHarness({
      readable: { [ALI]: ['Plugins/GTM', 'Plugins/GTM/access.md'] },
      authoredCrs: [cr({})],
    });
    server = h.server;
    const { plugins } = await listPlugins(h.baseUrl);
    expect(plugins[0]).toMatchObject({ name: 'gtm', canRead: true, hasRequested: false });
  });

  it('lists the owner verdict per caller — the folder verdict, not the manager one', async () => {
    const h = await makeHarness({
      readable: MEMBER_OF_BOTH,
      owner: { [ALI]: ['Plugins/GTM'] },
    });
    server = h.server;
    const { plugins } = await listPlugins(h.baseUrl);
    expect(plugins.find((g) => g.name === 'gtm')).toMatchObject({ isOwner: true });
    expect(plugins.find((g) => g.name === 'finance')).toMatchObject({ isOwner: false });
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
    for (const name of ['Nope', 'gtm']) {
      const res = await fetch(`${h.baseUrl}/api/plugins/${name}`, { method: 'DELETE' });
      expect(res.status, name).toBe(404);
      expect(await res.json()).toEqual({ error: 'Unknown plugin', kind: 'unknown-plugin' });
    }
    expect(h.provision.deletePlugin).not.toHaveBeenCalled();
  });

  it('delete: an OWNER deletes through the provision door — found by identity, deleted by folder', async () => {
    const h = await makeHarness({ owner: { [ALI]: ['Plugins/GTM'] } });
    server = h.server;
    const res = await fetch(`${h.baseUrl}/api/plugins/gtm`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // Provisioning owns folders, so it is handed the folder, not the name.
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
    const res = await fetch(`${h.baseUrl}/api/plugins/gtm`, { method: 'DELETE' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Unknown plugin' });
  });

  it('delete: 500s with its own words when the mechanism fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = await makeHarness({ owner: { [ALI]: ['Plugins/GTM'] } });
    h.provision.deletePlugin.mockRejectedValueOnce(new Error('push refused'));
    server = h.server;
    const res = await fetch(`${h.baseUrl}/api/plugins/gtm`, { method: 'DELETE' });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to delete the plugin' });
    error.mockRestore();
  });

  it('join-request: 404 for unknown AND for undiscoverable (identical, fail-closed)', async () => {
    const h = await makeHarness({});
    server = h.server;
    for (const name of ['Nope', 'gtm']) {
      const res = await fetch(`${h.baseUrl}/api/plugins/${name}/join-request`, { method: 'POST' });
      expect(res.status, name).toBe(404);
      expect(await res.json()).toEqual({ error: 'Unknown plugin', kind: 'unknown-plugin' });
    }
  });

  it('join-request: 409 when the caller can already read the folder', async () => {
    const h = await makeHarness({ readable: MEMBER_OF_BOTH });
    server = h.server;
    const res = await fetch(`${h.baseUrl}/api/plugins/finance/join-request`, { method: 'POST' });
    expect(res.status).toBe(409);
    expect((await res.json()).kind).toBe('already-readable');
  });

  it('join-request: records the ask and answers BEFORE any git has run', async () => {
    const h = await makeHarness({ readable: { [ALI]: ['Plugins/Finance/access.md'] } });
    server = h.server;
    // The one thing the endpoint may not do any more is wait for a clone. A
    // workflow that never settles stands in for one: the answer must arrive
    // anyway, and say the request is recorded and not yet carried.
    (h.workflow.createBranch as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}));

    const res = await fetch(`${h.baseUrl}/api/plugins/finance/join-request`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, state: 'pending', number: null });
    expect(h.joinRequestStore.all()).toMatchObject([
      { requesterEmail: ALI, pluginKey: 'Finance', status: 'pending', changeRequestNumber: null },
    ]);
    expect(h.workflow.openChangeRequest).not.toHaveBeenCalled();
  });

  it('join-request: the recorded request is REPORTED as requested before its CR exists', async () => {
    const h = await makeHarness({ readable: { [ALI]: ['Plugins/Finance/access.md'] } });
    server = h.server;
    (h.workflow.createBranch as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}));
    await fetch(`${h.baseUrl}/api/plugins/finance/join-request`, { method: 'POST' });

    // A reload one second after the click. No change request exists — the
    // record is the only thing that can answer, and it does.
    const { plugins } = await listPlugins(h.baseUrl);
    expect(plugins[0]).toMatchObject({
      name: 'finance',
      hasRequested: true,
      requestNumber: null,
      requestFailure: null,
    });
  });

  it('join-request: branch + splice + commit + CR, on the deterministic join branch — after the answer', async () => {
    const h = await makeHarness({ readable: { [ALI]: ['Plugins/Finance/access.md'] } });
    server = h.server;
    const res = await fetch(`${h.baseUrl}/api/plugins/finance/join-request`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, state: 'pending', number: null });
    await h.joinRequestJobs.drain();

    // The branch is cut from the FOLDER name, as every join branch before the
    // manifest became the identity was — so none of them is orphaned.
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
    // And the record now names the change request that carries it.
    expect(h.joinRequestStore.all()).toMatchObject([{ status: 'opened', changeRequestNumber: 42 }]);
  });

  it('keys a join request by the folder PATH below the root — two folders sharing a basename never share a branch', async () => {
    const h = await makeHarness({
      extraPlugins: { 'teams/GTM': 'team-gtm' },
      readable: { [ALI]: ['Plugins/teams/GTM/access.md'] },
    });
    server = h.server;
    const res = await fetch(`${h.baseUrl}/api/plugins/team-gtm/join-request`, { method: 'POST' });
    expect(res.status).toBe(200);
    await h.joinRequestJobs.drain();
    const branch = joinBranchFor(ALI, 'teams/GTM');
    expect(branch).not.toBe(joinBranchFor(ALI, 'GTM'));
    expect(h.workflow.createBranch).toHaveBeenCalledWith(wsId, branch, DEFAULT_BRANCH);
  });

  it('join-request adopts an existing open join CR instead of opening a second one', async () => {
    const h = await makeHarness({
      readable: { [ALI]: ['Plugins/Finance/access.md'] },
      authoredCrs: [cr({ branch: joinBranchFor(ALI, 'Finance'), number: 9 })],
    });
    server = h.server;
    const res = await fetch(`${h.baseUrl}/api/plugins/finance/join-request`, { method: 'POST' });
    expect(res.status).toBe(200);
    await h.joinRequestJobs.drain();
    expect(h.workflow.createBranch).not.toHaveBeenCalled();
    expect(h.workflow.openChangeRequest).not.toHaveBeenCalled();
    // The record ends up pointing at the request that was already there.
    expect(h.joinRequestStore.all()).toMatchObject([{ status: 'opened', changeRequestNumber: 9 }]);
  });

  it('join-request: two clicks leave ONE record and open ONE change request', async () => {
    const h = await makeHarness({ readable: { [ALI]: ['Plugins/Finance/access.md'] } });
    server = h.server;
    // Two tabs, at the same moment. Neither has seen the other's answer.
    const [first, second] = await Promise.all([
      fetch(`${h.baseUrl}/api/plugins/finance/join-request`, { method: 'POST' }),
      fetch(`${h.baseUrl}/api/plugins/finance/join-request`, { method: 'POST' }),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    // BOTH bodies, not just the statuses: the contract the concurrent path
    // advertises is that each tab is told the ask is recorded. Pinning only
    // the status would let this answer regress to a different shape — a
    // dropped `state`, a stale `number` — with the test still green.
    //
    // Either state is correct for a tab here, and which one is a race: the
    // git work is instant against these stubs, so the second answer can be
    // written after the first click's job has already opened the request. What
    // must hold for both is that the ask is recorded and the shape is the
    // shape — never a refusal, never a second request's number.
    for (const answer of [await first.json(), await second.json()]) {
      expect(answer).toEqual(
        answer.state === 'opened'
          ? { ok: true, state: 'opened', number: 42 }
          : { ok: true, state: 'pending', number: null },
      );
    }
    await h.joinRequestJobs.drain();

    expect(h.joinRequestStore.all()).toHaveLength(1);
    expect(h.workflow.openChangeRequest).toHaveBeenCalledTimes(1);
  });

  it('join-request: a failure is recorded, and the listing hands the plugin back with the reason', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = await makeHarness({ readable: { [ALI]: ['Plugins/Finance/access.md'] } });
    (h.workflow.openChangeRequest as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('the remote refused the push'),
    );
    server = h.server;
    const res = await fetch(`${h.baseUrl}/api/plugins/finance/join-request`, { method: 'POST' });
    // The answer was still instant and still said the ask was recorded — the
    // failure is a fact about what happened next.
    expect(await res.json()).toEqual({ ok: true, state: 'pending', number: null });
    await h.joinRequestJobs.drain();

    expect(h.joinRequestStore.all()).toMatchObject([
      { status: 'failed', failureReason: 'the remote refused the push' },
    ]);
    const { plugins } = await listPlugins(h.baseUrl);
    expect(plugins[0]).toMatchObject({
      name: 'finance',
      hasRequested: false,
      requestFailure: 'the remote refused the push',
    });
    error.mockRestore();
  });

  it('join-request: a click after a failure RETRIES the recorded request rather than recording a second', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = await makeHarness({ readable: { [ALI]: ['Plugins/Finance/access.md'] } });
    (h.workflow.openChangeRequest as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('the remote refused the push'),
    );
    server = h.server;
    await fetch(`${h.baseUrl}/api/plugins/finance/join-request`, { method: 'POST' });
    await h.joinRequestJobs.drain();
    const [failed] = h.joinRequestStore.all();

    await fetch(`${h.baseUrl}/api/plugins/finance/join-request`, { method: 'POST' });
    await h.joinRequestJobs.drain();

    const rows = h.joinRequestStore.all();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(failed.id);
    expect(rows[0]).toMatchObject({ status: 'opened', changeRequestNumber: 42, failureReason: null });
    expect(h.workflow.openChangeRequest).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });

  it('a request recorded before a restart is picked up by the sweep', async () => {
    const h = await makeHarness({ readable: { [ALI]: ['Plugins/Finance/access.md'] } });
    server = h.server;
    // The row a dead process left behind: recorded, never carried.
    h.joinRequestStore.seed({
      requesterEmail: ALI,
      requesterName: 'Ali Baba',
      pluginKey: 'Finance',
      status: 'pending',
      failureReason: null,
      changeRequestNumber: null,
      claimedAt: null,
    });

    await h.joinRequestJobs.sweep();
    await h.joinRequestJobs.drain();

    expect(h.workflow.openChangeRequest).toHaveBeenCalledTimes(1);
    expect(h.joinRequestStore.all()).toMatchObject([{ status: 'opened', changeRequestNumber: 42 }]);
  });

  it('degrades to the change requests alone when the recorded requests cannot be read', async () => {
    const h = await makeHarness({
      readable: { [ALI]: ['Plugins/Finance/access.md'] },
      authoredCrs: [cr({ branch: joinBranchFor(ALI, 'Finance'), number: 9 })],
    });
    vi.spyOn(h.joinRequestStore, 'forRequester').mockRejectedValueOnce(new Error('db down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    server = h.server;
    const { status, plugins } = await listPlugins(h.baseUrl);
    expect(status).toBe(200);
    expect(plugins[0]).toMatchObject({ hasRequested: true, requestNumber: 9 });
    warn.mockRestore();
  });

  it('a declined request is over: the listing hands the button back, and the next click asks again on the same record', async () => {
    // Before the record existed, "requested" came from the open change request
    // alone, so a decline handed the button back. The record must not change
    // that: an `opened` row whose request is closed is an answered ask. And
    // the answer has to come from the request's ROW — the authored listing
    // is open-only, so it never lists a closed request; a fixture that put
    // the closed request in the listing would pass a check that reads the
    // wrong source. The listing here is empty, as it is in production.
    const h = await makeHarness({ readable: { [ALI]: ['Plugins/Finance/access.md'] } });
    server = h.server;
    h.joinRequestStore.changeRequests.set(9, 'closed');
    const answered = h.joinRequestStore.seed({
      requesterEmail: ALI,
      requesterName: 'Ali Baba',
      pluginKey: 'Finance',
      status: 'opened',
      failureReason: null,
      changeRequestNumber: 9,
      claimedAt: null,
    });

    const { plugins } = await listPlugins(h.baseUrl);
    expect(plugins[0]).toMatchObject({
      name: 'finance',
      hasRequested: false,
      requestNumber: null,
      requestFailure: null,
    });

    const res = await fetch(`${h.baseUrl}/api/plugins/finance/join-request`, { method: 'POST' });
    expect(await res.json()).toEqual({ ok: true, state: 'pending', number: null });
    await h.joinRequestJobs.drain();

    const rows = h.joinRequestStore.all();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(answered.id);
    expect(rows[0]).toMatchObject({ status: 'opened', changeRequestNumber: 42 });
    expect(h.workflow.openChangeRequest).toHaveBeenCalledTimes(1);
  });

  it('an opened record whose request is still open counts, before the open listing knows it', async () => {
    // Marked seconds ago, the open listing cached without it: the request's
    // row says it is open, and that is what decides — not the listing, which
    // would otherwise flicker the card to a button right after a request
    // landed.
    const h = await makeHarness({ readable: { [ALI]: ['Plugins/Finance/access.md'] } });
    server = h.server;
    h.joinRequestStore.changeRequests.set(9, 'open');
    h.joinRequestStore.seed({
      requesterEmail: ALI,
      requesterName: 'Ali Baba',
      pluginKey: 'Finance',
      status: 'opened',
      failureReason: null,
      changeRequestNumber: 9,
      claimedAt: null,
    });
    const { plugins } = await listPlugins(h.baseUrl);
    expect(plugins[0]).toMatchObject({ name: 'finance', hasRequested: true, requestNumber: 9 });
  });

  it('keeps an opened record standing when its request\'s state cannot be read', async () => {
    // The third read the index makes, and the one whose failure must lean
    // the other way: a request that may well still be open must not be
    // handed back as a button, so an unreadable state is the benefit of the
    // doubt — the person sees the card, not an invitation to ask twice.
    const h = await makeHarness({ readable: { [ALI]: ['Plugins/Finance/access.md'] } });
    server = h.server;
    h.joinRequestStore.seed({
      requesterEmail: ALI,
      requesterName: 'Ali Baba',
      pluginKey: 'Finance',
      status: 'opened',
      failureReason: null,
      changeRequestNumber: 9,
      claimedAt: null,
    });
    vi.spyOn(h.joinRequestStore, 'changeRequestStates').mockRejectedValueOnce(new Error('db down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { status, plugins } = await listPlugins(h.baseUrl);
    expect(status).toBe(200);
    expect(plugins[0]).toMatchObject({ name: 'finance', hasRequested: true, requestNumber: 9 });
    warn.mockRestore();
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
    const res = await fetch(`${h.baseUrl}/api/plugins/gtm/join-requests`);
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
    const res = await fetch(`${h.baseUrl}/api/plugins/gtm/join-requests`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ requests: [] });
    expect(h.joinRequests.list).not.toHaveBeenCalled();
  });

  it('reconcile: 404 for a non-manager — indistinguishable from a missing request', async () => {
    const h = await makeHarness({ readable: MEMBER_OF_BOTH, authoredCrs: [cr({ number: 7 })] });
    server = h.server;
    const denied = await fetch(`${h.baseUrl}/api/plugins/gtm/join-requests/7/reconcile`, {
      method: 'POST',
    });
    expect(denied.status).toBe(404);
    expect(h.joinRequests.reconcile).not.toHaveBeenCalled();
  });

  it('reconcile: 404 for a manager when the change request does not exist', async () => {
    const h = await makeHarness({ writable: { [ALI]: ['Plugins/GTM/access.md'] } });
    server = h.server;
    const missing = await fetch(`${h.baseUrl}/api/plugins/gtm/join-requests/999/reconcile`, {
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
    const res = await fetch(`${h.baseUrl}/api/plugins/gtm/join-requests/7/reconcile`, {
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
