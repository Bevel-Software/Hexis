import type { Server as HttpServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalFilesystem } from '@mastra/core/workspace';
import { ToolRegistry } from '../../tool-registry/tool-registry.js';
import { createToolHandlerFactory } from '../../tool-helpers/tool-handler.js';
import type { ToolContext } from '../../tool-helpers/tool.contract.js';
import type { ToolAuth } from '../../tool-auth/tool-auth.middleware.js';
import { registerWorkspaceTools } from '../workspace.tools.js';
import { RoutineWritePolicyService } from '../routine-write-policy.js';
import { WorkflowHooks } from '../../workflow/workflow-hooks.js';
import { SpillStore } from '../spill-store.js';
import { DocExtractService } from '../file-readers/doc-extract.service.js';
import { AccessControlService } from '../../access/access-control.service.js';
import { NodeFs } from '../../kb-fs/node-fs.js';
import { workspaceIdForBranch } from '../../../shared/workspace-id.js';
import type { WorkspaceService } from '../workspace.service.js';

/**
 * `file_stat` with `access: true`, driven over the REAL resolver on an on-disk
 * knowledge base, so the explanation is proven against the same verdicts the
 * gates return — not against a double.
 */

const KB = 'knowledge-base';
const BRANCH = 'main';

const TREE: Record<string, string> = {
  'roles.yaml': 'roles:\n  Admin:\n    - admin@x.io\n  Engineer:\n    - eng@x.io\n    - dana@x.io\n',
  'groups.yaml': 'groups:\n  Sales Team:\n    - sam@x.io\n',
  'access.md': '---\nread:\n  - everyone\nwrite:\n  - Admin\n---\n',
  'Knowledge/access.md':
    '---\nread:\n  - Sales Team\n  - plugin/GTM/read\nwrite:\n  - role/Engineer\n  - deny Dana <dana@x.io>\nowner:\n  - Olive <olive@x.io>\n---\n',
  'Knowledge/Deal.md': '---\nnodeType: process\ndownload:\n  - Felix <felix@x.io>\n---\n# Deal\n',
  'Plugins/GTM/plugin.json': '{"name":"gtm"}',
  'Plugins/GTM/access.md': '---\nread:\n  - everyone\n---\nread:\n  - Pat <pat@x.io>\n',
};

let root = '';
let base = '';
let server: HttpServer;
let service: AccessControlService;
let caller = '';

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'file-stat-access-'));
  for (const [rel, text] of Object.entries(TREE)) {
    const abs = join(root, KB, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, text);
  }
  const workspaceService = { getWorkspacePath: async () => root, ensureRemotesFetched: async () => undefined } as unknown as WorkspaceService;
  service = new AccessControlService(workspaceService, KB, new NodeFs());
  const fs = new LocalFilesystem({ basePath: root, contained: true });

  const resolve = async (auth: ToolAuth, signal: AbortSignal, sessionId?: string): Promise<ToolContext> => ({
    user: { id: caller, email: caller, name: caller },
    scope: auth.scope,
    source: auth.source,
    sessionId,
    abortSignal: signal,
    workspaceService: workspaceService as never,
    workflowService: {} as never,
    events: {} as never,
    getFilesystem: async () => fs,
  });
  const app = express();
  app.use(express.json());
  const router = express.Router();
  const docCache = await mkdtemp(join(tmpdir(), 'file-stat-access-doc-'));
  registerWorkspaceTools(
    new ToolRegistry(),
    router,
    (req, _res, next) => {
      req.toolAuth = { source: 'internal', userId: caller, scope: 'read' };
      next();
    },
    createToolHandlerFactory(resolve),
    new SpillStore(join(tmpdir(), 'bevel-test-spills')),
    new DocExtractService(docCache),
    service,
    KB,
    { service: {} as never, enabled: false, kbDirName: KB, recoveryBotEmail: 'recovery-bot@bevel.local', hooks: new WorkflowHooks() },
    new RoutineWritePolicyService(),
    {} as never,
  );
  app.use('/api', router);
  server = await new Promise<HttpServer>((r) => {
    const s = app.listen(0, () => r(s));
  });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await rm(root, { recursive: true, force: true });
});

type Source = { kind: 'folder' | 'frontmatter'; path: string; inherited: boolean } | null;
type Decision = { allowed: boolean; source: Source; via: string; principal: string | null };
type Entry = { kind: string; name: string; email?: string; sources: Source[] };
type Stat = {
  type: string;
  access?: {
    self: Record<'read' | 'write' | 'download' | 'owner', Decision>;
    roster: Record<'read' | 'write' | 'download' | 'owner', Entry[]> | null;
    rosterReason?: string;
  };
};

async function stat(as: string, path: string, access = true): Promise<Stat> {
  caller = as;
  const res = await fetch(`${base}/api/agent/tools/file_stat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer x' },
    body: JSON.stringify({ branch: BRANCH, path, ...(access ? { access: true } : {}) }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Stat;
}

const DEAL = `${KB}/Knowledge/Deal.md`;
const KNOWLEDGE_FOLDER = { kind: 'folder', path: `${KB}/Knowledge` };

describe('file_stat access', () => {
  it('without the flag the response carries no access block', async () => {
    const out = await stat('olive@x.io', DEAL, false);
    expect(out.type).toBe('file');
    expect(out).not.toHaveProperty('access');
  });

  it('inherited: a person granted owner on the folder sees it decided there, inherited', async () => {
    const { access } = await stat('olive@x.io', DEAL);
    expect(access!.self.owner).toEqual({
      allowed: true,
      source: { ...KNOWLEDGE_FOLDER, inherited: true },
      via: 'person',
      principal: 'olive@x.io',
    });
  });

  it('direct: a download granted in the file frontmatter is not inherited', async () => {
    const { access } = await stat('felix@x.io', DEAL);
    expect(access!.self.download).toEqual({
      allowed: true,
      source: { kind: 'frontmatter', path: DEAL, inherited: false },
      via: 'person',
      principal: 'felix@x.io',
    });
    // read comes from `everyone` at the repository root.
    expect(access!.self.read).toMatchObject({
      allowed: true,
      source: { kind: 'folder', path: KB, inherited: true },
      via: 'everyone',
    });
  });

  it('direct on a folder: its own access.md decides, not inherited', async () => {
    const { access } = await stat('eng@x.io', `${KB}/Knowledge`);
    expect(access!.self.write).toEqual({
      allowed: true,
      source: { ...KNOWLEDGE_FOLDER, inherited: false },
      via: 'role',
      principal: 'Engineer',
    });
  });

  it('group: a group member reads via the group', async () => {
    const { access } = await stat('sam@x.io', DEAL);
    expect(access!.self.read).toEqual({
      allowed: true,
      source: { ...KNOWLEDGE_FOLDER, inherited: true },
      via: 'group',
      principal: 'Sales Team',
    });
  });

  it('role: a role member writes via the role', async () => {
    const { access } = await stat('eng@x.io', DEAL);
    expect(access!.self.write).toMatchObject({ allowed: true, via: 'role', principal: 'Engineer' });
  });

  it('deny: a person denied write keeps the deny and where it is written, over their role grant', async () => {
    const { access } = await stat('dana@x.io', DEAL);
    expect(access!.self.write).toEqual({
      allowed: false,
      source: { ...KNOWLEDGE_FOLDER, inherited: true },
      via: 'person',
      principal: 'dana@x.io',
    });
  });

  it('plugin principal: a plugin member reads via the plugin principal', async () => {
    const { access } = await stat('pat@x.io', DEAL);
    expect(access!.self.read).toMatchObject({
      allowed: true,
      source: { ...KNOWLEDGE_FOLDER, inherited: true },
      via: 'plugin',
    });
  });

  it('default-deny carries no source', async () => {
    const { access } = await stat('sam@x.io', DEAL);
    expect(access!.self.write).toEqual({ allowed: false, source: null, via: 'default-deny', principal: null });
  });

  it('a non-manager gets self only and a null roster with a reason', async () => {
    for (const who of ['sam@x.io', 'felix@x.io', 'pat@x.io', 'dana@x.io']) {
      const { access } = await stat(who, DEAL);
      expect(access!.self).toBeTruthy();
      expect(access!.roster).toBeNull();
      expect(access!.rosterReason).toMatch(/cannot change who has access/);
    }
  });

  it('a manager gets the roster per verb, each entry with its sources', async () => {
    const { access } = await stat('olive@x.io', DEAL);
    const roster = access!.roster!;
    expect(roster).not.toBeNull();
    const find = (verb: keyof typeof roster, name: string) => roster[verb].find((e) => e.name === name || e.email === name);

    expect(find('read', 'Sales Team')).toEqual({ kind: 'group', name: 'Sales Team', sources: [{ ...KNOWLEDGE_FOLDER, inherited: true }] });
    expect(find('read', 'plugin/gtm/read')).toMatchObject({ kind: 'plugin', sources: [{ ...KNOWLEDGE_FOLDER, inherited: true }] });
    expect(find('read', 'everyone')).toMatchObject({ kind: 'role', sources: [{ kind: 'folder', path: KB, inherited: true }] });
    expect(find('write', 'Engineer')).toEqual({ kind: 'role', name: 'Engineer', sources: [{ ...KNOWLEDGE_FOLDER, inherited: true }] });
    expect(find('owner', 'olive@x.io')).toMatchObject({ kind: 'person', sources: [{ ...KNOWLEDGE_FOLDER, inherited: true }] });
    expect(find('download', 'felix@x.io')).toMatchObject({
      kind: 'person',
      sources: [{ kind: 'frontmatter', path: DEAL, inherited: false }],
    });
    // A denied person is not on the write roster.
    expect(find('write', 'dana@x.io')).toBeUndefined();
  });

  it('a manager through a role gets the roster of the folder they can manage', async () => {
    const { access } = await stat('eng@x.io', `${KB}/Knowledge`);
    expect(access!.roster).not.toBeNull();
    expect(access!.roster!.owner.find((e) => e.email === 'olive@x.io')).toMatchObject({
      sources: [{ ...KNOWLEDGE_FOLDER, inherited: false }],
    });
  });

  it('every verdict agrees with the gate the operations use', async () => {
    const workspaceId = workspaceIdForBranch(BRANCH);
    const rel = 'Knowledge/Deal.md';
    for (const who of ['olive@x.io', 'felix@x.io', 'eng@x.io', 'dana@x.io', 'sam@x.io', 'pat@x.io', 'admin@x.io', 'nobody@x.io']) {
      const { access } = await stat(who, DEAL);
      const self = access!.self;
      expect(self.read.allowed, `${who} read`).toBe(await service.canRead(workspaceId, who, rel));
      expect(self.write.allowed, `${who} write`).toBe(await service.canWrite(workspaceId, who, rel));
      expect(self.download.allowed, `${who} download`).toBe(await service.canDownload(workspaceId, who, rel));
      expect(self.owner.allowed, `${who} owner`).toBe(await service.canOwner(workspaceId, who, rel));
    }
  });
});
