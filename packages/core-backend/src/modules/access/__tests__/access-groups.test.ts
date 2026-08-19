import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { WorkspaceService } from '../../workspace/workspace.service.js';
import { AccessControlService, parseRolesYaml } from '../access-control.service.js';
import { AccessConfigError } from '../../access-model/access-errors.js';
import { addMember, parseRolesModel, emitRolesModel } from '../roles-edit.js';

const execFileAsync = promisify(execFile);
const KB_DIR = 'knowledge-base';

async function mkTmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'bevel-groups-'));
}

async function seedWorkspace(root: string, workspaceId: string) {
  const workspaceDir = path.join(root, workspaceId);
  const repo = path.join(workspaceDir, KB_DIR);
  await fs.mkdir(repo, { recursive: true });
  return { workspaceDir, repo };
}

async function writeFile(repo: string, rel: string, contents: string): Promise<void> {
  const abs = path.join(repo, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, contents);
}

function stubWorkspaceService(workspaceId: string, workspaceDir: string): WorkspaceService {
  return {
    getWorkspacePath: async (id: string) => {
      if (id !== workspaceId) throw new Error(`unexpected workspace ${id}`);
      return workspaceDir;
    },
    ensureRemotesFetched: async () => undefined,
  } as unknown as WorkspaceService;
}

const ROLES_YAML = `roles:
  Admin:
    - admin@x.io
`;

const GROUPS_YAML_TEXT = `groups:
  Engineering:
    - ada@x.io
    - bo@x.io
  Sales: []
`;

describe('group files as access principals', () => {
  let root: string;
  const workspaceId = 'ws-groups-1';

  beforeEach(async () => {
    root = await mkTmpRoot();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function makeService(files: Record<string, string>) {
    const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
    for (const [rel, contents] of Object.entries(files)) {
      await writeFile(repo, rel, contents);
    }
    return new AccessControlService(stubWorkspaceService(workspaceId, workspaceDir), KB_DIR);
  }

  it('manual mode: a groups.yaml group grants access when named in access.md', async () => {
    const svc = await makeService({
      'roles.yaml': ROLES_YAML,
      'groups.yaml': GROUPS_YAML_TEXT,
      'access.md': '---\nwrite:\n  - Admin\nread:\n  - Engineering\n---\n',
    });
    expect(await svc.canRead(workspaceId, 'ada@x.io', 'Knowledge/Doc.md')).toBe(true);
    expect(await svc.canRead(workspaceId, 'bo@x.io', 'Knowledge/Doc.md')).toBe(true);
    // Not in the group, not otherwise granted → default-deny.
    expect(await svc.canRead(workspaceId, 'mallory@x.io', 'Knowledge/Doc.md')).toBe(false);
    // Group grant confers read only — not write.
    expect(await svc.canWrite(workspaceId, 'ada@x.io', 'Knowledge/Doc.md')).toBe(false);
  });

  it('blank group keys (even several) are skipped — every OTHER group keeps resolving', async () => {
    const svc = await makeService({
      'roles.yaml': ROLES_YAML,
      // Blank keys (and their members) are entry-level problems; a hard parse
      // failure — including a duplicate-'' key error — would retire
      // Engineering too, fail-closed.
      'groups.yaml':
        'groups:\n  :\n    - stray@x.io\n  Engineering:\n    - ada@x.io\n  :\n    - stray2@x.io\n',
      'access.md': '---\nread:\n  - Engineering\n---\n',
    });
    expect(await svc.canRead(workspaceId, 'ada@x.io', 'Knowledge/Doc.md')).toBe(true);
    expect(await svc.canRead(workspaceId, 'stray@x.io', 'Knowledge/Doc.md')).toBe(false);
    expect(await svc.canRead(workspaceId, 'stray2@x.io', 'Knowledge/Doc.md')).toBe(false);
  });

  it('validateGroupsFile (the WRITE gate) still refuses blank keys the reader forgives', async () => {
    const { validateGroupsFile } = await import('../group-files.js');
    // Inside `groups:` — refused via the entry warning (strict gate).
    expect(validateGroupsFile('groups:\n  :\n    - a@x.io\n', 'groups.yaml').ok).toBe(false);
    // At the ROOT — the tolerant reader silently drops this without any
    // warning, so only the strict pre-parse refuses it. This is the case the
    // strict parse exists for.
    expect(
      validateGroupsFile(':\n  - stray@x.io\ngroups:\n  Engineering:\n    - ada@x.io\n', 'groups.yaml').ok,
    ).toBe(false);
  });

  it('a group reference with no group file behind it grants nothing', async () => {
    const svc = await makeService({
      'roles.yaml': ROLES_YAML,
      'access.md': '---\nread:\n  - Engineering\n---\n',
    });
    expect(await svc.canRead(workspaceId, 'ada@x.io', 'Knowledge/Doc.md')).toBe(false);
  });

  it('IdP mode: synced-groups.yaml presence retires groups.yaml entirely', async () => {
    const svc = await makeService({
      'roles.yaml': ROLES_YAML,
      // The manual file still names ada; the synced file has a different team.
      'groups.yaml': GROUPS_YAML_TEXT,
      'synced-groups.yaml': 'groups:\n  Platform:\n    - zoe@x.io\n',
      'access.md': '---\nread:\n  - Engineering\n  - Platform\n---\n',
    });
    // Synced group resolves…
    expect(await svc.canRead(workspaceId, 'zoe@x.io', 'Knowledge/Doc.md')).toBe(true);
    // …the retired manual group does NOT (its name is now unknown → dropped).
    expect(await svc.canRead(workspaceId, 'ada@x.io', 'Knowledge/Doc.md')).toBe(false);
  });

  it('BROKEN groups degrade loudly: bare tokens fall through to roles, health marker set', async () => {
    const svc = await makeService({
      'roles.yaml': `roles:\n  Admin:\n    - admin@x.io\n  Engineering:\n    - lead@x.io\n`,
      // Structurally broken manual file — groups contribute nothing…
      'groups.yaml': 'groups:\n  - not\n  - a\n  - mapping\n',
      'access.md': '---\nread:\n  - Engineering\n---\n',
    });
    // …and the bare token falls through to the ROLE per precedence, so
    // access control keeps working (owner's degrade decision, not fail-closed).
    expect(await svc.canRead(workspaceId, 'lead@x.io', 'Knowledge/Doc.md')).toBe(true);
    expect(await svc.canRead(workspaceId, 'ada@x.io', 'Knowledge/Doc.md')).toBe(false);

    // The load-level health marker names the file and the reason.
    const { loadActiveGroups } = await import('../access-control.service.js');
    const active = await loadActiveGroups(async (f) =>
      f === 'groups.yaml' ? 'groups:\n  - not\n  - a\n  - mapping\n' : null,
    );
    expect(active.groups.size).toBe(0);
    expect(active.health).toMatchObject({ ok: false, file: 'groups.yaml' });
    expect((active.health as { reason?: string }).reason).toMatch(/mapping|list/i);
  });

  it('a non-absence READ error on synced-groups.yaml is broken-groups, never a manual fallback', async () => {
    const { loadActiveGroups } = await import('../access-control.service.js');
    const active = await loadActiveGroups(async (f) => {
      if (f === 'synced-groups.yaml') {
        const err = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      }
      // A fallback would read the manual file and resurrect retired groups.
      return 'groups:\n  Retired Team:\n    - ghost@x.io\n';
    });
    expect(active.groups.size).toBe(0); // NOT the retired manual groups
    expect(active.health).toMatchObject({ ok: false, file: 'synced-groups.yaml' });
    // While genuine absence (ENOENT) still means manual mode:
    const manual = await loadActiveGroups(async (f) => {
      if (f === 'synced-groups.yaml') {
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return 'groups:\n  Live Team:\n    - here@x.io\n';
    });
    expect(manual.health).toEqual({ ok: true });
    expect([...manual.groups.keys()]).toEqual(['live team']);
  });

  it('a malformed synced file keeps IdP mode (no fallback to manual groups)', async () => {
    const svc = await makeService({
      'roles.yaml': ROLES_YAML,
      'groups.yaml': GROUPS_YAML_TEXT,
      'synced-groups.yaml': 'groups:\n  - not\n  - a\n  - mapping\n',
      'access.md': '---\nread:\n  - Engineering\n---\n',
    });
    // Falling back to groups.yaml would resurrect retired manual groups.
    expect(await svc.canRead(workspaceId, 'ada@x.io', 'Knowledge/Doc.md')).toBe(false);
  });

  it('a bare name shared by a group and a role resolves to the GROUP (grant side)', async () => {
    const svc = await makeService({
      'roles.yaml': `roles:\n  Admin:\n    - admin@x.io\n  Engineering:\n    - lead@x.io\n`,
      // The group "Engineering" collides with the ROLE Engineering.
      'groups.yaml': GROUPS_YAML_TEXT,
      'access.md': '---\nread:\n  - Engineering\n---\n',
    });
    // Group-first precedence: the group's members read; the role's member no
    // longer resolves through the bare token (use role/Engineering for that).
    expect(await svc.canRead(workspaceId, 'ada@x.io', 'Knowledge/Doc.md')).toBe(true);
    expect(await svc.canRead(workspaceId, 'lead@x.io', 'Knowledge/Doc.md')).toBe(false);
    // The display surface resolves the bare token to the group too — and says
    // WHAT it is, so the dialog badges the row "Group", not "Role".
    const readers = await svc.eligibleReaders(workspaceId, 'Knowledge/Doc.md');
    expect(readers.roles).toContain('Engineering');
    expect(readers.principals).toContainEqual({ name: 'Engineering', kind: 'group' });
  });

  it('a bare-name DENY resolves to the group; role/<Name> reaches the role (writers included)', async () => {
    const svc = await makeService({
      'roles.yaml': `roles:\n  Admin:\n    - admin@x.io\n  Engineering:\n    - lead@x.io\n`,
      'groups.yaml': GROUPS_YAML_TEXT,
      'access.md':
        '---\nread:\n  - everyone\n  - deny Engineering\nwrite:\n  - role/Engineering\n---\n',
    });
    // The deny bites the GROUP's members, not the role's.
    expect(await svc.canRead(workspaceId, 'ada@x.io', 'Knowledge/Doc.md')).toBe(false);
    expect(await svc.canRead(workspaceId, 'lead@x.io', 'Knowledge/Doc.md')).toBe(true);
    // The explicit token grants the ROLE write.
    expect(await svc.canWrite(workspaceId, 'lead@x.io', 'Knowledge/Doc.md')).toBe(true);
    expect(await svc.canWrite(workspaceId, 'ada@x.io', 'Knowledge/Doc.md')).toBe(false);
    // eligibleWriters resolves the explicit token to the role's display name —
    // and carries kind 'role': the `role/` alias always means the role, even
    // with a same-named group in play.
    const writers = await svc.eligibleWriters(workspaceId, 'Knowledge/Doc.md');
    expect(writers.roles).toContain('Engineering');
    expect(writers.principals).toContainEqual({ name: 'Engineering', kind: 'role' });
  });

  it('role/Admin resolves to the ROLE even when a synced group is named Admin', async () => {
    const svc = await makeService({
      'roles.yaml': ROLES_YAML,
      'synced-groups.yaml': 'groups:\n  Admin:\n    - attacker@evil.io\n',
      'access.md': '---\nwrite:\n  - role/Admin\nread:\n  - Admin\n---\n',
    });
    // The explicit token is the role — the shadowing group gets nothing here.
    expect(await svc.canWrite(workspaceId, 'admin@x.io', 'Knowledge/Doc.md')).toBe(true);
    expect(await svc.canWrite(workspaceId, 'attacker@evil.io', 'Knowledge/Doc.md')).toBe(false);
    // The BARE token is the group now (group-first): its member reads.
    expect(await svc.canRead(workspaceId, 'attacker@evil.io', 'Knowledge/Doc.md')).toBe(true);
    // Admin CAPABILITY never leaks to the group: roles.yaml write is a pure
    // is-admin check keyed on the role, and admin-rescue keeps working.
    expect(await svc.canWrite(workspaceId, 'attacker@evil.io', 'roles.yaml')).toBe(false);
    expect(await svc.canWrite(workspaceId, 'admin@x.io', 'roles.yaml')).toBe(true);
    expect(await svc.canWrite(workspaceId, 'admin@x.io', 'access.md')).toBe(true);
  });

  it('assigning a role to a group (`group:` ref) expands through membership', async () => {
    const svc = await makeService({
      'roles.yaml': `roles:\n  Admin:\n    - admin@x.io\n  Plugin Creator:\n    - jane@x.io\n    - group:Engineering\n`,
      'groups.yaml': GROUPS_YAML_TEXT,
      'access.md': '---\nwrite:\n  - Plugin Creator\n---\n',
    });
    // Individual assignee and every group member hold the role's grants.
    expect(await svc.canWrite(workspaceId, 'jane@x.io', 'Tools/plugin.tool')).toBe(true);
    expect(await svc.canWrite(workspaceId, 'ada@x.io', 'Tools/plugin.tool')).toBe(true);
    expect(await svc.canWrite(workspaceId, 'bo@x.io', 'Tools/plugin.tool')).toBe(true);
    // Group membership confers the ROLE's grants, not admin status.
    expect(await svc.canWrite(workspaceId, 'ada@x.io', 'roles.yaml')).toBe(false);
  });

  it('a role group-ref to an unknown group contributes nothing', async () => {
    const svc = await makeService({
      'roles.yaml': `roles:\n  Admin:\n    - admin@x.io\n  Reviewer:\n    - rev@x.io\n    - group:Ghosts\n`,
      'groups.yaml': GROUPS_YAML_TEXT,
      'access.md': '---\nread:\n  - Reviewer\n---\n',
    });
    expect(await svc.canRead(workspaceId, 'rev@x.io', 'Knowledge/Doc.md')).toBe(true);
  });

  it('Admin group refs are allowed (NEW) and expand to admin capability', async () => {
    const withRef = `roles:\n  Admin:\n    - admin@x.io\n    - group:Platform Admins\n`;
    expect(parseRolesYaml(withRef).ok).toBe(true);
    const svc = await makeService({
      'roles.yaml': withRef,
      'groups.yaml': 'groups:\n  Platform Admins:\n    - ops@x.io\n',
      'access.md': '---\nwrite:\n  - role/Admin\n---\n',
    });
    // Group members expand into the Admin ROLE — capability included.
    expect(await svc.canWrite(workspaceId, 'ops@x.io', 'Knowledge/Doc.md')).toBe(true);
    expect(await svc.canWrite(workspaceId, 'ops@x.io', 'roles.yaml')).toBe(true);
    expect(await svc.canWrite(workspaceId, 'admin@x.io', 'roles.yaml')).toBe(true);
  });

  it('a group-ONLY Admin is refused at parse and hard-errors at load (kept invariant)', async () => {
    const bad = `roles:\n  Admin:\n    - group:Platform Admins\n`;
    const parsed = parseRolesYaml(bad);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors.join(' ')).toMatch(/direct email/);
    }

    const svc = await makeService({
      'roles.yaml': bad,
      'groups.yaml': 'groups:\n  Platform Admins:\n    - ops@x.io\n',
      'access.md': '---\nwrite:\n  - Admin\n---\n',
    });
    await expect(svc.canWrite(workspaceId, 'admin@x.io', 'Knowledge/Doc.md')).rejects.toThrow(
      AccessConfigError,
    );
  });

  it('roles.yaml group refs survive unrelated roles-edit round-trips', () => {
    const text = `roles:\n  Admin:\n    - admin@x.io\n  Plugin Creator:\n    - group:Engineering\n`;
    const edited = addMember(text, 'admin', 'second@x.io');
    expect(edited.changed).toBe(true);
    expect(edited.text).toContain('group:engineering');
    // And the re-emit is stable: parse → emit round-trips the ref.
    expect(emitRolesModel(parseRolesModel(edited.text))).toBe(edited.text);
  });

  it('resolves groups AT A REF for the gate paths', async () => {
    const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
    await writeFile(repo, 'roles.yaml', ROLES_YAML);
    await writeFile(repo, 'synced-groups.yaml', 'groups:\n  Engineering:\n    - ada@x.io\n');
    await writeFile(repo, 'access.md', '---\nread:\n  - Engineering\nwrite:\n  - Engineering\n---\n');
    const git = (...args: string[]) => execFileAsync('git', ['-C', repo, ...args]);
    await git('init', '-b', 'main');
    await git('config', 'user.email', 'test@x.io');
    await git('config', 'user.name', 'Test');
    await git('add', '-A');
    await git('commit', '-m', 'seed');

    // The committed state grants ada; the WORKING TREE then revokes the group
    // — the at-ref answer must come from the commit, not the tree.
    await fs.writeFile(path.join(repo, 'synced-groups.yaml'), 'groups: {}\n'.replace('{}', ''));

    const svc = new AccessControlService(stubWorkspaceService(workspaceId, workspaceDir), KB_DIR);
    expect(await svc.canWriteAtRef(workspaceId, 'main', 'ada@x.io', 'Knowledge/Doc.md')).toBe(true);
    expect(await svc.canWriteAtRef(workspaceId, 'main', 'zoe@x.io', 'Knowledge/Doc.md')).toBe(false);
  });

  it('synced-groups.yaml is machine-owned: only the sync bot writes it, ever', async () => {
    const { workspaceDir } = await seedWorkspace(root, workspaceId);
    const svc = new AccessControlService(stubWorkspaceService(workspaceId, workspaceDir), KB_DIR);

    // The bot needs no roles/grants — the rule resolves before the model
    // loads (this workspace has no git repo at all).
    expect(
      await svc.canWriteAtRef(workspaceId, 'HEAD', 'directory-sync@bevel.local', 'synced-groups.yaml'),
    ).toBe(true);
    // No human is eligible — not even Admin. Hand-edits would be silently
    // overwritten by the next provisioning push.
    expect(
      await svc.canWriteAtRef(workspaceId, 'HEAD', 'admin@x.io', 'synced-groups.yaml'),
    ).toBe(false);
    // Same answers through the batch gate the lock service actually uses.
    const batch = await svc.canWriteBatchAtRef(workspaceId, 'HEAD', 'directory-sync@bevel.local', [
      'synced-groups.yaml',
    ]);
    expect(batch?.get('synced-groups.yaml')).toBe(true);
    // The eligible-writers surface names the bot, so the 403 payload and the
    // UI say "machine-owned", not "nobody".
    const eligible = await svc.eligibleWritersAtRef(workspaceId, 'HEAD', 'synced-groups.yaml');
    expect(eligible?.users.map((u) => u.email)).toEqual(['directory-sync@bevel.local']);
    expect(eligible?.roles).toEqual([]);
  });
});
