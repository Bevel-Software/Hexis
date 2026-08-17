import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import type { WorkspaceService } from '../../workspace/workspace.service.js';
import type { WorkflowService } from '../../workflow/workflow.service.js';
import type { AuthUser, FileTreeEntry } from '@bevel-software/platform-shared';
import { DEFAULT_BRANCH } from '@bevel-software/platform-shared';
import { AccessControlService } from '../access-control.service.js';
import { RolesAdminService } from '../roles-admin.service.js';

const KB = 'knowledge-base';
const ADMIN: AuthUser = { id: 'u-admin', email: 'admin@x.io', name: 'Admin' } as AuthUser;

const ROLES = `roles:
  Admin:
    - admin@x.io
  Plugin Creator:
    - jane@x.io
    - group:engineering
  Product:
    - felix@x.io
    - sara@x.io
`;

async function write(repo: string, rel: string, contents: string): Promise<void> {
  const abs = path.join(repo, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, contents);
}

function stubWorkspace(workspaceDir: string): WorkspaceService {
  const resolve = (wsRel: string) => path.join(workspaceDir, wsRel);
  const buildTree = async (absDir: string): Promise<FileTreeEntry> => {
    const rel = path.relative(workspaceDir, absDir).replace(/\\/g, '/');
    const children: FileTreeEntry[] = [];
    for (const e of await fs.readdir(absDir, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const childAbs = path.join(absDir, e.name);
      if (e.isDirectory()) children.push(await buildTree(childAbs));
      else if (e.isFile()) {
        children.push({
          name: e.name,
          relativePath: path.relative(workspaceDir, childAbs).replace(/\\/g, '/'),
          type: 'file',
        });
      }
    }
    return { name: path.basename(absDir), relativePath: rel || '.', type: 'directory', children };
  };
  return {
    getWorkspacePath: async () => workspaceDir,
    getOrCreateForBranch: async () => ({}) as unknown,
    listFiles: async () => buildTree(workspaceDir),
    readFile: async (_id: string, wsRel: string) => fs.readFile(resolve(wsRel), 'utf-8'),
  } as unknown as WorkspaceService;
}

function stubWorkflow() {
  const commits: { summary: string }[] = [];
  let holder: AuthUser | null = null;
  const lockRow = (h: AuthUser) => ({ holderUserId: h.id, holderName: h.name });
  const svc = {
    getLock: async () => (holder ? lockRow(holder) : null),
    acquireLock: async (...a: unknown[]) => {
      const user = a[3] as AuthUser;
      return holder && holder.id !== user.id
        ? { acquired: false, lock: lockRow(holder) }
        : ((holder = user), { acquired: true, lock: lockRow(user) });
    },
    releaseLock: async () => {
      holder = null;
    },
    releaseLockNoCommit: async () => {
      holder = null;
    },
    commitChanges: async (_ws: string, _user: AuthUser, summary: string) => {
      commits.push({ summary });
      return {} as unknown;
    },
  } as unknown as WorkflowService;
  return { svc, commits };
}

describe('RolesAdminService — capabilities, group assignment, conversion', () => {
  let root: string;
  let repo: string;
  let service: RolesAdminService;
  let commits: { summary: string }[];

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-roles-cap-'));
    repo = path.join(root, KB);
    await write(repo, 'roles.yaml', ROLES);
    await write(repo, 'access.md', '---\nwrite:\n  - Admin\nread:\n  - Product\n---\n');
    const workspace = stubWorkspace(root);
    const workflow = stubWorkflow();
    commits = workflow.commits;
    service = new RolesAdminService(
      workspace,
      workflow.svc,
      new AccessControlService(workspace as never, KB),
      KB,
      () => DEFAULT_BRANCH,
    );
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const rolesYaml = () => fs.readFile(path.join(repo, 'roles.yaml'), 'utf-8');
  const groupsYaml = () => fs.readFile(path.join(repo, 'groups.yaml'), 'utf-8');

  it('roster: capability metadata, legacy flag, and members/groups split', async () => {
    const roster = await service.getRoster();
    const admin = roster.find((r) => r.canonical === 'admin')!;
    expect(admin.capability).toMatchObject({ groupAssignable: false });
    expect(admin.capability?.description).toContain('configuration');

    const creator = roster.find((r) => r.canonical === 'plugin creator')!;
    expect(creator.members).toEqual(['jane@x.io']); // group ref split out
    expect(creator.groups).toEqual(['engineering']);
    expect(creator.capability).toBeNull(); // not in the registry (yet)

    const product = roster.find((r) => r.canonical === 'product')!;
    expect(product.capability).toBeNull(); // legacy people-set role
    expect(product.referencedBy).toEqual([{ path: 'access.md', verb: 'read' }]);
  });

  it('assigns and unassigns a group on a non-Admin role', async () => {
    await service.assignGroup(ADMIN, 'product', 'GTM Team');
    expect(await rolesYaml()).toContain('- group:gtm team');

    const roster = await service.unassignGroup(ADMIN, 'product', 'GTM Team');
    expect(await rolesYaml()).not.toContain('group:gtm team');
    expect(roster.find((r) => r.canonical === 'product')?.groups).toEqual([]);
  });

  it('refuses to assign Admin to a group', async () => {
    await expect(service.assignGroup(ADMIN, 'admin', 'Engineering')).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining('cannot be assigned to a group'),
    });
    expect(await rolesYaml()).not.toContain('group:engineering\n    - admin');
  });

  it('converts a legacy role to a group atomically; grants keep the name', async () => {
    const roster = await service.convertRoleToGroup(ADMIN, 'product');

    expect(roster.some((r) => r.canonical === 'product')).toBe(false);
    expect(await rolesYaml()).not.toContain('Product');
    expect(await groupsYaml()).toContain('Product:\n    - felix@x.io\n    - sara@x.io');
    expect(commits).toHaveLength(1);
    expect(commits[0].summary).toContain('Convert role Product to a group');
    // The grant text was never touched — the name carries over.
    const accessMd = await fs.readFile(path.join(repo, 'access.md'), 'utf-8');
    expect(accessMd).toContain('- Product');
  });

  it('conversion refusals: capability role, group-assigned role, IdP mode', async () => {
    await expect(service.convertRoleToGroup(ADMIN, 'admin')).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining('capability role'),
    });
    await expect(service.convertRoleToGroup(ADMIN, 'plugin creator')).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining('assigned to groups'),
    });

    await write(repo, 'synced-groups.yaml', 'groups:\n  Engineering:\n    - ada@x.io\n');
    await expect(service.convertRoleToGroup(ADMIN, 'product')).rejects.toMatchObject({
      status: 409,
      payload: { kind: 'idp-mode' },
    });
  });

  it('conversion refuses a groups.yaml name collision', async () => {
    await write(repo, 'groups.yaml', 'groups:\n  Product:\n    - other@x.io\n');
    await expect(service.convertRoleToGroup(ADMIN, 'product')).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining('already exists'),
    });
    // Nothing moved: the role survives an aborted conversion.
    expect(await rolesYaml()).toContain('Product:');
  });
});
