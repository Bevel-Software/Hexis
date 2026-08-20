import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import type { WorkspaceService } from '../../workspace/workspace.service.js';
import type { WorkflowService } from '../../workflow/workflow.service.js';
import type { AuthUser, FileTreeEntry } from '@bevel-software/platform-shared';
import { DEFAULT_BRANCH } from '@bevel-software/platform-shared';
import { AccessControlService } from '../access-control.service.js';
import { GroupsAdminService, GroupsAdminError } from '../groups-admin.service.js';
import { createGroup, addGroupMember, GroupsEditError } from '../groups-edit.js';

const KB = 'knowledge-base';
const ADMIN: AuthUser = { id: 'u-admin', email: 'admin@x.io', name: 'Admin' } as AuthUser;

const ROLES = `roles:\n  Admin:\n    - admin@x.io\n  Reviewer:\n    - rev@x.io\n`;
const GROUPS = `groups:\n  Product:\n    - felix@x.io\n  GTM Team:\n    - sara@x.io\n`;

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
  const svc = {
    getLock: async (_w: string, _b: string, p: string) => {
      const h = locks.get(p);
      return h ? lockRow(h) : null;
    },
    acquireLock: async (_w: string, _b: string, p: string, user: AuthUser) => {
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
  return { svc, commits };
}

describe('GroupsAdminService', () => {
  let root: string;
  let repo: string;
  let service: GroupsAdminService;
  let commits: { summary: string }[];

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-groups-admin-'));
    repo = path.join(root, KB);
    await write(repo, 'roles.yaml', ROLES);
    await write(repo, 'groups.yaml', GROUPS);
    await write(repo, 'access.md', '---\nwrite:\n  - Admin\n---\n');
    const workspace = stubWorkspace(root);
    const workflow = stubWorkflow();
    commits = workflow.commits;
    service = new GroupsAdminService(
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

  const groupsYaml = () => fs.readFile(path.join(repo, 'groups.yaml'), 'utf-8');

  it('roster: manual mode, groups with members, grant references, role assignments, health', async () => {
    await write(repo, 'Knowledge/Sales/access.md', '---\nread:\n  - GTM Team\n---\n');
    await write(
      repo,
      'roles.yaml',
      'roles:\n  Admin:\n    - admin@x.io\n  Reviewer:\n    - rev@x.io\n    - group:gtm team\n',
    );
    const roster = await service.getRoster();
    expect(roster.mode).toBe('manual');
    expect(roster.groupsHealth).toEqual({ ok: true });
    expect(roster.groups.map((g) => g.displayName).sort()).toEqual(['GTM Team', 'Product']);
    const gtm = roster.groups.find((g) => g.canonical === 'gtm team');
    expect(gtm?.members).toEqual(['sara@x.io']);
    expect(gtm?.referencedBy).toEqual([{ path: 'Knowledge/Sales/access.md', verb: 'read' }]);
    // Which roles carry a group:<canonical> assignment — feeds the delete
    // confirm's "these roles will lose members" warning.
    expect(gtm?.assignedToRoles).toEqual(['reviewer']);
    expect(roster.groups.find((g) => g.canonical === 'product')?.assignedToRoles).toEqual([]);
  });

  it('a broken MANUAL groups.yaml answers the roster with 422 + the parse message', async () => {
    await write(repo, 'groups.yaml', 'groups:\n  - not\n  - a\n  - mapping\n');
    const err = await service.getRoster().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GroupsAdminError);
    expect((err as GroupsAdminError).status).toBe(422);
    expect((err as GroupsAdminError).message).toMatch(/groups.yaml/);
    expect((err as GroupsAdminError).payload).toMatchObject({ kind: 'broken-groups' });
    // The message carries WHAT to fix — never a dead Groups page.
    expect((err as GroupsAdminError).payload?.reason).toBeTruthy();
  });

  it('a broken SYNCED file keeps IdP mode: empty roster + groupsHealth marker (no manual fallback)', async () => {
    await write(repo, 'synced-groups.yaml', 'groups:\n  - not\n  - a\n  - mapping\n');
    const roster = await service.getRoster();
    expect(roster.mode).toBe('idp');
    // Falling back to groups.yaml would resurrect retired manual groups.
    expect(roster.groups).toEqual([]);
    expect(roster.groupsHealth).toMatchObject({ ok: false, file: 'synced-groups.yaml' });
  });

  it('deleteGroup unassigns roles.yaml group refs in the SAME atomic commit', async () => {
    await write(
      repo,
      'roles.yaml',
      'roles:\n  Admin:\n    - admin@x.io\n  Reviewer:\n    - rev@x.io\n    - group:gtm team\n  Ops:\n    - group:GTM  Team\n',
    );
    const roster = await service.deleteGroup(ADMIN, 'gtm team');
    expect(roster.groups.some((g) => g.canonical === 'gtm team')).toBe(false);
    expect(await groupsYaml()).not.toContain('GTM Team');
    const roles = await fs.readFile(path.join(repo, 'roles.yaml'), 'utf-8');
    // Every ref gone — including the un-normalized hand-written one — with
    // the rest of each role intact, in ONE commit with the groups.yaml edit.
    expect(roles).not.toContain('gtm');
    expect(roles).toContain('- rev@x.io');
    expect(commits).toHaveLength(1);
    expect(commits[0].summary).toContain('Delete group gtm team');
  });

  it("createGroup refuses the reserved 'role/' prefix (name-safety)", async () => {
    await expect(service.createGroup(ADMIN, 'role/ops')).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("role/"),
    });
    expect(await groupsYaml()).not.toContain('role/');
  });

  it('create → add → remove → delete lifecycle lands on disk', async () => {
    await service.createGroup(ADMIN, 'Contractors');
    await service.addMember(ADMIN, 'contractors', 'temp@x.io');
    expect(await groupsYaml()).toContain('Contractors:\n    - temp@x.io');

    await service.removeMember(ADMIN, 'contractors', 'temp@x.io');
    expect(await groupsYaml()).toContain('Contractors: []');

    const roster = await service.deleteGroup(ADMIN, 'contractors');
    expect(roster.groups.some((g) => g.canonical === 'contractors')).toBe(false);
    expect(await groupsYaml()).not.toContain('Contractors');
  });

  it('refuses a group name that shadows a role (deliberate friction — IdP collisions resolve by precedence instead)', async () => {
    await expect(service.createGroup(ADMIN, 'Reviewer')).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining('role name'),
    });
    await expect(service.renameGroup(ADMIN, 'product', 'Admin')).rejects.toMatchObject({
      status: 422,
    });
  });

  it('IdP mode: mutations refuse with the typed 409; reads still work', async () => {
    await write(repo, 'synced-groups.yaml', 'groups:\n  Engineering:\n    - ada@x.io\n');
    const roster = await service.getRoster();
    expect(roster.mode).toBe('idp');
    // The roster IS the synced file now — not the retired manual list.
    expect(roster.groups.map((g) => g.canonical)).toEqual(['engineering']);
    expect(roster.groups[0].members).toEqual(['ada@x.io']);

    for (const call of [
      () => service.createGroup(ADMIN, 'New Team'),
      () => service.addMember(ADMIN, 'product', 'x@x.io'),
      () => service.removeMember(ADMIN, 'product', 'felix@x.io'),
      () => service.deleteGroup(ADMIN, 'product'),
      () => service.renameGroup(ADMIN, 'product', 'Products'),
    ]) {
      const err = await call().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GroupsAdminError);
      expect((err as GroupsAdminError).status).toBe(409);
      expect((err as GroupsAdminError).payload).toMatchObject({ kind: 'idp-mode' });
    }
    // The connect dialog still needs the manual names in IdP-adjacent states.
    expect((await service.listManualGroupNames()).sort()).toEqual(['GTM Team', 'Product']);
  });

  it('canonical-changing rename rewrites grant references in ONE commit', async () => {
    await write(repo, 'Knowledge/Sales/access.md', '---\nread:\n  - GTM Team\nwrite:\n  - deny GTM Team\n---\n');
    await service.renameGroup(ADMIN, 'gtm team', 'Go To Market');

    expect(await groupsYaml()).toContain('Go To Market:');
    const rewritten = await fs.readFile(path.join(repo, 'Knowledge/Sales/access.md'), 'utf-8');
    expect(rewritten).toContain('- Go To Market');
    expect(rewritten).toContain('- deny Go To Market');
    expect(rewritten).not.toContain('GTM Team');
    expect(commits).toHaveLength(1);
    expect(commits[0].summary).toContain('gtm team → Go To Market');
  });

  it('rename rewrites a BODY-GOVERNED access.md (rules live below the frontmatter)', async () => {
    // New-format file: frontmatter governs access.md itself, the body is the
    // folder's rules — exactly what the resolver enforces.
    await write(
      repo,
      'Knowledge/Sales/access.md',
      '---\nwrite:\n  - Admin\n---\nread:\n  - GTM Team\nwrite:\n  - deny GTM Team\n',
    );
    // The scan must see the body rule too (delete warnings / referencedBy).
    const roster = await service.getRoster();
    const gtm = roster.groups.find((g) => g.canonical === 'gtm team');
    expect(gtm?.referencedBy).toContainEqual({ path: 'Knowledge/Sales/access.md', verb: 'read' });

    await service.renameGroup(ADMIN, 'gtm team', 'Go To Market');
    const rewritten = await fs.readFile(path.join(repo, 'Knowledge/Sales/access.md'), 'utf-8');
    expect(rewritten).toContain('- Go To Market');
    expect(rewritten).toContain('- deny Go To Market');
    expect(rewritten).not.toContain('GTM Team');
    // The frontmatter self-rule is a rule source too, and Admin is untouched.
    expect(rewritten).toContain('- Admin');
  });

  it('rename rewrites role→group assignments (group:<ref> in roles.yaml) in the SAME commit', async () => {
    await write(
      repo,
      'roles.yaml',
      'roles:\n  Admin:\n    - admin@x.io\n  Reviewer:\n    - rev@x.io\n    - group:gtm team\n',
    );
    await service.renameGroup(ADMIN, 'gtm team', 'Go To Market');

    const roles = await fs.readFile(path.join(repo, 'roles.yaml'), 'utf-8');
    // The stored ref is canonical — it must follow the rename, or the role
    // silently stops expanding to the group's members.
    expect(roles).toContain('group:go to market');
    expect(roles).not.toContain('group:gtm team');
    // Atomic: groups.yaml + roles.yaml land as ONE commit.
    expect(commits).toHaveLength(1);
  });

  it('rollback of a failed commit DELETES a file this edit created (no empty artifact)', async () => {
    await fs.rm(path.join(repo, 'groups.yaml'));
    const workspace = stubWorkspace(root);
    const workflow = stubWorkflow();
    (workflow.svc as unknown as { commitChanges: unknown }).commitChanges = async () => {
      throw new Error('commit exploded');
    };
    const svc = new GroupsAdminService(
      workspace,
      workflow.svc,
      new AccessControlService(workspace as never, KB),
      KB,
      () => DEFAULT_BRANCH,
    );
    await expect(svc.createGroup(ADMIN, 'Contractors')).rejects.toThrow('commit exploded');
    // groups.yaml did not exist before the edit → the rollback removes it
    // instead of leaving an empty file behind as a new artifact.
    await expect(groupsYaml()).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('a path whose restore failed is released WITHOUT commit (discard, never partial publish)', async () => {
    const workspace = stubWorkspace(root);
    const workflow = stubWorkflow();
    const wf = workflow.svc as unknown as {
      commitChanges: (...a: unknown[]) => Promise<unknown>;
      releaseLock: (...a: unknown[]) => Promise<void>;
      releaseLockNoCommit: (...a: unknown[]) => Promise<void>;
    };
    wf.commitChanges = async () => {
      throw new Error('commit exploded');
    };
    const committingReleases: string[] = [];
    const discardingReleases: string[] = [];
    const origRelease = wf.releaseLock.bind(workflow.svc);
    const origNoCommit = wf.releaseLockNoCommit.bind(workflow.svc);
    wf.releaseLock = async (...a) => {
      committingReleases.push(a[2] as string);
      return origRelease(...a);
    };
    wf.releaseLockNoCommit = async (...a) => {
      discardingReleases.push(a[2] as string);
      return origNoCommit(...a);
    };
    // The edit's own write lands; the rollback write then fails — the tree
    // holds known-partial bytes, so the release must DISCARD, not commit.
    const ws = workspace as unknown as { writeFile: (...a: unknown[]) => Promise<void> };
    const origWrite = ws.writeFile.bind(workspace);
    let writes = 0;
    ws.writeFile = async (...a) => {
      writes += 1;
      if (writes >= 2) throw new Error('disk full');
      return origWrite(...a);
    };
    const svc = new GroupsAdminService(
      workspace,
      workflow.svc,
      new AccessControlService(workspace as never, KB),
      KB,
      () => DEFAULT_BRANCH,
    );
    await expect(svc.addMember(ADMIN, 'product', 'new@x.io')).rejects.toThrow('commit exploded');
    expect(discardingReleases).toEqual([`${KB}/groups.yaml`]);
    expect(committingReleases).not.toContain(`${KB}/groups.yaml`);
  });

  it('retireManualGroups deletes the file once; git history is the recovery', async () => {
    expect(await service.retireManualGroups(ADMIN)).toBe(true);
    await expect(groupsYaml()).rejects.toMatchObject({ code: 'ENOENT' });
    expect(commits.some((c) => c.summary.includes('Retire manual groups'))).toBe(true);
    // Already gone → honest no-op.
    expect(await service.retireManualGroups(ADMIN)).toBe(false);
  });

  it('retireManualGroups checks existence UNDER the lock — a create that races in still gets retired', async () => {
    // groups.yaml is absent when retire is called, but a concurrent createGroup
    // lands it right as the retire acquires the lock. Checked before the lock
    // (the old shape) retire would answer false and the manual file would
    // linger into IdP mode, ready to resurrect if the synced file ever goes
    // away. Checked under the lock, the just-created file is seen and retired.
    await fs.rm(path.join(repo, 'groups.yaml'));
    const workspace = stubWorkspace(root);
    const workflow = stubWorkflow();
    const wf = workflow.svc as unknown as {
      acquireLock: (w: string, b: string, p: string, u: AuthUser) => Promise<unknown>;
    };
    const origAcquire = wf.acquireLock.bind(workflow.svc);
    wf.acquireLock = async (w, b, p, u) => {
      if (p === `${KB}/groups.yaml`) {
        await write(repo, 'groups.yaml', 'groups:\n  Late Team:\n    - late@x.io\n');
      }
      return origAcquire(w, b, p, u);
    };
    const svc = new GroupsAdminService(
      workspace,
      workflow.svc,
      new AccessControlService(workspace as never, KB),
      KB,
      () => DEFAULT_BRANCH,
    );
    expect(await svc.retireManualGroups(ADMIN)).toBe(true);
    await expect(groupsYaml()).rejects.toMatchObject({ code: 'ENOENT' });
    expect(workflow.commits.some((c) => c.summary.includes('Retire manual groups'))).toBe(true);
  });
});

describe('groups-edit guardrails', () => {
  it('refuses reserved and structurally-unsafe names', () => {
    expect(() => createGroup('', 'everyone')).toThrow(GroupsEditError);
    expect(() => createGroup('', 'Ops: West')).toThrow(GroupsEditError);
    expect(() => createGroup('', '-lead')).toThrow(GroupsEditError);
  });

  it('refuses malformed member emails', () => {
    const base = createGroup('', 'Team').text;
    expect(() => addGroupMember(base, 'team', 'not-an-email')).toThrow(GroupsEditError);
  });

  it('refuses a group:-prefixed member (groups do not nest; a member is always an email)', () => {
    const base = createGroup('', 'Team').text;
    // `group:lee@x.io` passes the email regex, so without the explicit refusal
    // this would land a dead never-matching entry instead of an actionable 422.
    expect(() => addGroupMember(base, 'team', 'group:lee@x.io')).toThrow(
      /a group member is always a person's email/,
    );
    expect(() => addGroupMember(base, 'team', 'group:GTM Team')).toThrow(GroupsEditError);
  });
});

describe('groups roster referencedBy — the mirror of the roles roster attribution', () => {
  it('a group shadowed BY a role name still owns its bare-token hits; role/<name> hits are never the group’s', async () => {
    const root2 = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-groups-shadow-'));
    try {
      const repo2 = path.join(root2, KB);
      // A group named Reviewer shares the Reviewer role's name. Group-first
      // precedence gives the GROUP the bare key, so the bare hit is its
      // reference; the explicit role/ hit belongs to the ROLE roster only.
      await write(repo2, 'roles.yaml', ROLES); // declares role Reviewer
      await write(repo2, 'groups.yaml', 'groups:\n  Reviewer:\n    - pat@x.io\n');
      await write(repo2, 'team/access.md', '---\nread:\n  - Reviewer\nwrite:\n  - role/Reviewer\n---\n');
      const workspace = stubWorkspace(root2);
      const svc = new GroupsAdminService(
        workspace,
        stubWorkflow().svc,
        new AccessControlService(workspace as never, KB),
        KB,
        () => DEFAULT_BRANCH,
      );
      const roster = await svc.getRoster();
      const reviewer = roster.groups.find((g) => g.canonical === 'reviewer')!;
      expect(reviewer.referencedBy).toEqual([{ path: 'team/access.md', verb: 'read' }]);
    } finally {
      await fs.rm(root2, { recursive: true, force: true });
    }
  });
});
