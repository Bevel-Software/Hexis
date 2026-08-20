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
    writeFile: async (_id: string, wsRel: string, content: string) => {
      await fs.mkdir(path.dirname(resolve(wsRel)), { recursive: true });
      await fs.writeFile(resolve(wsRel), content);
    },
    deleteFile: async (_id: string, wsRel: string) => {
      await fs.rm(resolve(wsRel));
    },
  } as unknown as WorkspaceService;
}

function stubWorkflow() {
  const commits: { summary: string }[] = [];
  // Strict per-path locks — a live row is contended even for the same user,
  // exactly like FileLockService (nesting bugs must fail here too).
  const locks = new Map<string, AuthUser>();
  const lockRow = (h: AuthUser) => ({ holderUserId: h.id, holderName: h.name });
  const acquireCalls: { path: string; coordination: boolean }[] = [];
  const svc = {
    getLock: async (_w: string, _b: string, p: string) => {
      const h = locks.get(p);
      return h ? lockRow(h) : null;
    },
    acquireLock: async (
      _w: string,
      _b: string,
      p: string,
      user: AuthUser,
      opts?: { coordination?: boolean },
    ) => {
      acquireCalls.push({ path: p, coordination: !!opts?.coordination });
      // Mirror the production lock-time write gate on the machine-owned file:
      // synced-groups.yaml refuses every non-bot WRITE-intent acquire on the
      // (always protected) default branch. Only a coordination acquire — a
      // pure mutex claiming no write authority — may hold it for a human.
      if (p === `${KB}/synced-groups.yaml` && !opts?.coordination) {
        throw new Error(`Access denied: no write permission on "${p}" (machine-owned)`);
      }
      const h = locks.get(p);
      if (h) return { acquired: false, lock: lockRow(h) };
      locks.set(p, user);
      return { acquired: true, lock: lockRow(user) };
    },
    releaseLock: async (_w: string, _b: string, p: string) => {
      locks.delete(p);
    },
    releaseLockNoCommit: async (_w: string, _b: string, p: string) => {
      locks.delete(p);
    },
    commitChanges: async (_ws: string, _user: AuthUser, summary: string) => {
      commits.push({ summary });
      return {} as unknown;
    },
  } as unknown as WorkflowService;
  return { svc, commits, acquireCalls };
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
    // Assignable groups must exist in the ACTIVE source — assignGroup
    // validates against it (a ref to a missing group is a dead grant).
    await write(repo, 'groups.yaml', 'groups:\n  GTM Team:\n    - sara@x.io\n');
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
    expect(admin.capability).toMatchObject({ groupAssignable: true });
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

  it('refuses to assign a group the active source does not know (dead grant)', async () => {
    const before = await rolesYaml();
    await expect(service.assignGroup(ADMIN, 'product', 'Ghost Team')).rejects.toMatchObject({
      status: 404,
      payload: { kind: 'unknown-group', group: 'Ghost Team' },
    });
    expect(await rolesYaml()).toBe(before);
  });

  it('assigns a group to Admin (NEW) — the invariant lives in the direct-email rule, not a ban', async () => {
    await service.assignGroup(ADMIN, 'admin', 'GTM Team');
    expect(await rolesYaml()).toContain('- group:gtm team');
    const roster = await service.getRoster();
    expect(roster.find((r) => r.canonical === 'admin')?.groups).toEqual(['gtm team']);
    // But Admin can never drop its LAST direct email — group refs don't count.
    await expect(
      service.removeMember(ADMIN, 'admin', 'admin@x.io', true),
    ).rejects.toMatchObject({ status: 422, message: expect.stringContaining('direct email') });
    expect(await rolesYaml()).toContain('- admin@x.io');
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

  it('manual-mode conversion works for a HUMAN admin: the synced file is held as a COORDINATION lock', async () => {
    // synced-groups.yaml is machine-owned — the lock-time write gate refuses
    // every human actor (the stub's acquireLock enforces this exactly like
    // production). The conversion still needs the file's lock to serialize
    // with a provisioning push, so it must take it as a coordination hold
    // that claims no write authority. A write-intent acquire here would fail
    // EVERY manual-mode conversion at lock acquisition.
    const workspace = stubWorkspace(root);
    const workflow = stubWorkflow();
    const svc = new RolesAdminService(
      workspace,
      workflow.svc,
      new AccessControlService(workspace as never, KB),
      KB,
      () => DEFAULT_BRANCH,
    );
    const roster = await svc.convertRoleToGroup(ADMIN, 'product');
    expect(roster.some((r) => r.canonical === 'product')).toBe(false);
    expect(await groupsYaml()).toContain('Product:');
    // The synced file WAS locked (the serialization is real), via coordination;
    // the written files keep their write-gated acquires.
    expect(workflow.acquireCalls).toContainEqual({
      path: `${KB}/synced-groups.yaml`,
      coordination: true,
    });
    expect(workflow.acquireCalls).toContainEqual({ path: `${KB}/roles.yaml`, coordination: false });
    expect(workflow.acquireCalls).toContainEqual({ path: `${KB}/groups.yaml`, coordination: false });
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

  it('conversion re-checks IdP mode UNDER the synced file lock (TOCTOU: a sync landing mid-flight refuses)', async () => {
    // The pre-lock IdP check passes (no synced file yet). Directory sync then
    // materializes synced-groups.yaml just before the conversion gets its
    // locks — the same interleaving the synced file's lock serializes in
    // production. The under-lock recheck must refuse with the typed 409 and
    // write nothing (committing a groups.yaml group in IdP mode writes a
    // retired file).
    const workspace = stubWorkspace(root);
    const workflow = stubWorkflow();
    const wf = workflow.svc as unknown as {
      acquireLock: (
        w: string,
        b: string,
        p: string,
        u: AuthUser,
        opts?: { coordination?: boolean },
      ) => Promise<unknown>;
    };
    const origAcquire = wf.acquireLock.bind(workflow.svc);
    wf.acquireLock = async (w, b, p, u, opts) => {
      if (p === `${KB}/synced-groups.yaml`) {
        // The sync's provisioning push won the race for this lock and landed.
        await write(repo, 'synced-groups.yaml', 'groups:\n  Engineering:\n    - ada@x.io\n');
      }
      return origAcquire(w, b, p, u, opts);
    };
    const svc = new RolesAdminService(
      workspace,
      workflow.svc,
      new AccessControlService(workspace as never, KB),
      KB,
      () => DEFAULT_BRANCH,
    );
    await expect(svc.convertRoleToGroup(ADMIN, 'product')).rejects.toMatchObject({
      status: 409,
      payload: { kind: 'idp-mode' },
    });
    // Nothing moved.
    expect(await rolesYaml()).toBe(ROLES);
    expect(await groupsYaml()).not.toContain('Product');
    expect(workflow.commits).toHaveLength(0);
  });

  it('a failed conversion with NO pre-existing groups.yaml leaves no groups.yaml behind', async () => {
    await fs.rm(path.join(repo, 'groups.yaml'));
    const workspace = stubWorkspace(root);
    const workflow = stubWorkflow();
    (workflow.svc as unknown as { commitChanges: unknown }).commitChanges = async () => {
      throw new Error('commit exploded');
    };
    const svc = new RolesAdminService(
      workspace,
      workflow.svc,
      new AccessControlService(workspace as never, KB),
      KB,
      () => DEFAULT_BRANCH,
    );
    await expect(svc.convertRoleToGroup(ADMIN, 'product')).rejects.toThrow('commit exploded');
    // groups.yaml was CREATED by this conversion → rollback deletes it
    // instead of publishing an empty file as a brand-new artifact.
    await expect(groupsYaml()).rejects.toMatchObject({ code: 'ENOENT' });
    // …and roles.yaml got its original bytes back: the role survives.
    expect(await rolesYaml()).toBe(ROLES);
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
