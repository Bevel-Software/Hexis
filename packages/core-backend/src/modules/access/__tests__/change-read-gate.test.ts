import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { NodeFs } from '../../kb-fs/node-fs.js';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import { AccessControlService } from '../access-control.service.js';
import { ChangeReadGate, isNewTopLevelFolderPath } from '../change-read-gate.js';
import { AccessDeniedError } from '../../access-model/access-errors.js';
import { SYNCED_GROUPS_YAML } from '../../access-model/group-files.js';

const KB = 'knowledge-base';
const WS = 'ws-gate';
const ALICE = 'alice@example.com';
const ADMIN = 'razvan@bevel.software';

const ROLES_YAML = `roles:
  Admin:
    - ${ADMIN}
`;

async function write(repo: string, rel: string, contents: string): Promise<void> {
  const abs = path.join(repo, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, contents);
}

function stubWorkspaceService(workspaceDir: string): WorkspaceService {
  return {
    getWorkspacePath: async (id: string) => {
      if (id !== WS) throw new Error(`unexpected workspace ${id}`);
      return workspaceDir;
    },
  } as unknown as WorkspaceService;
}

/**
 * "You can only change what you can see": the verdict every lock acquire
 * asks for, against a real access tree on disk. Read is default-deny and the
 * test tree's root grants nobody, so every path is unreadable until a case
 * says otherwise.
 */
describe('ChangeReadGate', () => {
  let root: string;
  let repo: string;
  let gate: ChangeReadGate;
  let access: AccessControlService;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-change-gate-'));
    const workspaceDir = path.join(root, WS);
    repo = path.join(workspaceDir, KB);
    for (const d of ['KnowledgeBase', 'Skills', 'Plugins', 'Data']) {
      await fs.mkdir(path.join(repo, d), { recursive: true });
    }
    await write(repo, 'roles.yaml', ROLES_YAML);
    const ws = stubWorkspaceService(workspaceDir);
    access = new AccessControlService(ws, KB, new NodeFs());
    gate = new ChangeReadGate(ws, access, KB, new NodeFs());
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const judge = (email: string, wsPath: string, kind: 'file' | 'dir' = 'file') =>
    gate.judge(WS, email, wsPath, kind);

  it('a path outside the knowledge-base repository has no read rules and passes', async () => {
    expect(await judge(ALICE, 'reserved-config.json')).toEqual({ allowed: true, via: 'outside-kb' });
  });

  it('a readable folder lets a new file in, a readable file lets a change through', async () => {
    await write(repo, 'KnowledgeBase/Sales/access.md', '---\nread:\n  - everyone\n---\n');
    await write(repo, 'KnowledgeBase/Sales/deal.md', 'x');
    expect(await judge(ALICE, `${KB}/KnowledgeBase/Sales/new.md`)).toEqual({ allowed: true, via: 'readable' });
    expect(await judge(ALICE, `${KB}/KnowledgeBase/Sales/deal.md`)).toEqual({ allowed: true, via: 'readable' });
  });

  it('a new file in a folder the caller cannot read is refused, naming the folder', async () => {
    await fs.mkdir(path.join(repo, 'KnowledgeBase/Sealed'), { recursive: true });
    expect(await judge(ALICE, `${KB}/KnowledgeBase/Sealed/brief.pdf`)).toEqual({
      allowed: false,
      unreadable: 'KnowledgeBase/Sealed',
    });
  });

  it('a change to a file the caller cannot read is refused, naming the file', async () => {
    await write(repo, 'KnowledgeBase/Sealed/deal.md', 'x');
    expect(await judge(ALICE, `${KB}/KnowledgeBase/Sealed/deal.md`)).toEqual({
      allowed: false,
      unreadable: 'KnowledgeBase/Sealed/deal.md',
    });
  });

  it('a write grant does not stand in for read: a nearer deny read still refuses', async () => {
    await write(repo, 'KnowledgeBase/access.md', `---\nwrite:\n  - Alice <${ALICE}>\n---\n`);
    await write(repo, 'KnowledgeBase/Board/access.md', `---\nread:\n  - deny Alice <${ALICE}>\n---\n`);
    // Write folds into read at the root scope…
    expect(await judge(ALICE, `${KB}/KnowledgeBase/memo.md`)).toEqual({ allowed: true, via: 'readable' });
    // …but the nearer folder takes the read away, and the write with it.
    expect(await judge(ALICE, `${KB}/KnowledgeBase/Board/memo.md`)).toEqual({
      allowed: false,
      unreadable: 'KnowledgeBase/Board',
    });
  });

  it('a loose file directly at an unreadable root is refused, naming the root', async () => {
    expect(await judge(ALICE, `${KB}/KnowledgeBase/notes.md`)).toEqual({
      allowed: false,
      unreadable: 'KnowledgeBase',
    });
    expect(await judge(ALICE, `${KB}/AGENTS.md`)).toEqual({ allowed: false, unreadable: '' });
  });

  describe('the exception: a new folder directly under one of the three roots', () => {
    it('lets a file inside a folder that does not exist yet through, at each of the three roots', async () => {
      for (const p of ['KnowledgeBase/Projects/plan.md', 'Skills/my-skill/SKILL.md', 'Plugins/team/access.md']) {
        expect(await judge(ALICE, `${KB}/${p}`), p).toEqual({ allowed: true, via: 'new-top-level-folder' });
      }
    });

    it('lets the folder itself through when asked about as a folder', async () => {
      expect(await judge(ALICE, `${KB}/KnowledgeBase/Projects`, 'dir')).toEqual({
        allowed: true,
        via: 'new-top-level-folder',
      });
    });

    it('covers the whole new subtree, however deep', async () => {
      expect(await judge(ALICE, `${KB}/KnowledgeBase/Projects/2026/q4/plan.md`)).toEqual({
        allowed: true,
        via: 'new-top-level-folder',
      });
    });

    it('does not cover a folder that already exists', async () => {
      await fs.mkdir(path.join(repo, 'KnowledgeBase/Projects'), { recursive: true });
      expect(await judge(ALICE, `${KB}/KnowledgeBase/Projects/plan.md`)).toEqual({
        allowed: false,
        unreadable: 'KnowledgeBase/Projects',
      });
    });

    it('does not cover a new folder under any other root', async () => {
      expect(await judge(ALICE, `${KB}/Data/Engineering/plan.md`)).toEqual({
        allowed: false,
        unreadable: 'Data/Engineering',
      });
      expect(await judge(ALICE, `${KB}/Data/Engineering`, 'dir')).toEqual({
        allowed: false,
        unreadable: 'Data',
      });
    });

    it('does not cover a loose file at the root, asked about as a file', async () => {
      // `KnowledgeBase/Projects` as a FILE is a loose file at the root, not a folder.
      expect(await judge(ALICE, `${KB}/KnowledgeBase/Projects`, 'file')).toEqual({
        allowed: false,
        unreadable: 'KnowledgeBase',
      });
    });
  });

  describe('the rescues the write rule already has', () => {
    it('an admin may change a file directly in the repository root whatever the root grants', async () => {
      expect(await judge(ADMIN, `${KB}/groups.yaml`)).toEqual({ allowed: true, via: 'admin-rescue' });
      expect(await judge(ADMIN, `${KB}/access.md`)).toEqual({ allowed: true, via: 'admin-rescue' });
      expect(await judge(ADMIN, `${KB}/roles.yaml`)).toEqual({ allowed: true, via: 'admin-rescue' });
    });

    it('the rescue stops at the root: an admin excluded from a subfolder cannot change its rules', async () => {
      await write(repo, 'KnowledgeBase/Board/access.md', '---\nread:\n  - deny everyone\n---\n');
      expect(await judge(ADMIN, `${KB}/KnowledgeBase/Board/access.md`)).toEqual({
        allowed: false,
        unreadable: 'KnowledgeBase/Board/access.md',
      });
    });

    it('a non-admin gets no rescue on root files', async () => {
      expect(await judge(ALICE, `${KB}/groups.yaml`)).toEqual({ allowed: false, unreadable: '' });
    });

    it('the rescues name FILES: a folder target at the root is judged as a folder, even for an admin', async () => {
      // The KB clone's own folder, asked about as an extraction destination:
      // the root scope, which here grants nobody — an admin included.
      expect(await judge(ADMIN, KB, 'dir')).toEqual({ allowed: false, unreadable: '' });
      expect(await judge(ADMIN, `${KB}/KnowledgeBase`, 'dir')).toEqual({ allowed: false, unreadable: 'KnowledgeBase' });
      // With a root that lets the admin read (write folds into read), the same folders open.
      await write(repo, 'access.md', `---\nowner:\n  - Admin\n---\nwrite:\n  - Admin\n`);
      access.invalidate(WS);
      expect(await judge(ADMIN, KB, 'dir')).toEqual({ allowed: true, via: 'readable' });
    });

    it('a roles.yaml that is there but unusable is not an open door', async () => {
      await fs.mkdir(path.join(repo, 'KnowledgeBase/Sealed'), { recursive: true });
      await write(repo, 'roles.yaml', 'roles: [not: valid\n');
      await expect(judge(ALICE, `${KB}/KnowledgeBase/Sealed/x.md`)).rejects.toThrow(/Access-control config is invalid/);
    });

    it('a link where the new folder would be is something there, not a new folder', async () => {
      await fs.symlink(path.join(root, 'elsewhere'), path.join(repo, 'KnowledgeBase/Linked'));
      expect(await judge(ALICE, `${KB}/KnowledgeBase/Linked/a.md`)).toEqual({
        allowed: false,
        unreadable: 'KnowledgeBase/Linked',
      });
    });

    it('the directory-sync file is machine-owned: the write rule names its writer, not this gate', async () => {
      expect(await judge(ALICE, `${KB}/${SYNCED_GROUPS_YAML}`)).toEqual({ allowed: true, via: 'machine-owned' });
    });

    it('a tree with no usable access config decides nothing, like the write gate', async () => {
      await fs.mkdir(path.join(repo, 'KnowledgeBase/Sealed'), { recursive: true });
      await fs.rm(path.join(repo, 'roles.yaml'));
      expect(await judge(ALICE, `${KB}/KnowledgeBase/Sealed/x.md`)).toEqual({ allowed: true, via: 'no-rules' });
    });
  });

  describe('assertMayChange', () => {
    it('throws an AccessDeniedError that names the unreadable place and carries no eligible lists', async () => {
      await fs.mkdir(path.join(repo, 'KnowledgeBase/Sealed'), { recursive: true });
      const err = await gate
        .assertMayChange(WS, ALICE, `${KB}/KnowledgeBase/Sealed/brief.pdf`, 'file')
        .then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(AccessDeniedError);
      const denied = err as AccessDeniedError;
      expect(denied.access).toEqual({
        path: `${KB}/KnowledgeBase/Sealed/brief.pdf`,
        eligibleRoles: [],
        eligibleUsers: [],
        unreadable: 'KnowledgeBase/Sealed',
      });
      expect(denied.message).toBe(
        `You don't have permission to write to "${KB}/KnowledgeBase/Sealed/brief.pdf". You don't have read access to "KnowledgeBase/Sealed"; only what you can read can be created, changed or removed.`,
      );
      expect(denied.status).toBe(403);
    });

    it('names the top level when the root itself is the unreadable place', async () => {
      const err = await gate
        .assertMayChange(WS, ALICE, `${KB}/notes.md`, 'file')
        .then(() => null, (e: unknown) => e);
      expect((err as AccessDeniedError).message).toContain("You don't have read access to the top level;");
    });

    it('resolves quietly when the change is allowed', async () => {
      await expect(gate.assertMayChange(WS, ALICE, `${KB}/Skills/new-skill/SKILL.md`, 'file')).resolves.toBeUndefined();
    });
  });
});

describe('isNewTopLevelFolderPath', () => {
  const onDisk = new Set(['KnowledgeBase/Existing', 'Skills/known']);
  const exists = async (p: string) => onDisk.has(p);

  it('is true for a path inside a folder directly under a creatable root that is not on disk', async () => {
    expect(await isNewTopLevelFolderPath('KnowledgeBase/New/a.md', 'file', exists)).toBe(true);
    expect(await isNewTopLevelFolderPath('Skills/fresh/SKILL.md', 'file', exists)).toBe(true);
    expect(await isNewTopLevelFolderPath('Plugins/team/deep/er/x', 'file', exists)).toBe(true);
    expect(await isNewTopLevelFolderPath('KnowledgeBase/New', 'dir', exists)).toBe(true);
  });

  it('is false when the top-level folder exists, for a loose file at the root, and outside the three roots', async () => {
    expect(await isNewTopLevelFolderPath('KnowledgeBase/Existing/a.md', 'file', exists)).toBe(false);
    expect(await isNewTopLevelFolderPath('Skills/known', 'dir', exists)).toBe(false);
    expect(await isNewTopLevelFolderPath('KnowledgeBase/loose.md', 'file', exists)).toBe(false);
    expect(await isNewTopLevelFolderPath('KnowledgeBase', 'dir', exists)).toBe(false);
    expect(await isNewTopLevelFolderPath('Data/New/a.md', 'file', exists)).toBe(false);
    expect(await isNewTopLevelFolderPath('roles.yaml', 'file', exists)).toBe(false);
  });
});
