import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import type { WorkspaceService } from '../../workspace/workspace.service.js';
import { AccessControlService } from '../access-control.service.js';
import { AccessConfigError } from '../access-errors.js';

const PROCESS_MAP_DIR = 'knowledge-base';

async function mkTmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'bevel-access-'));
}

interface Seed {
  workspaceDir: string;
  repo: string;
}

async function seedWorkspace(root: string, workspaceId: string): Promise<Seed> {
  const workspaceDir = path.join(root, workspaceId);
  const repo = path.join(workspaceDir, PROCESS_MAP_DIR);
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
  } as unknown as WorkspaceService;
}

const ROLES_YAML = `roles:
  Admin:
    - razvan@bevel.software
  Product Manager:
    - felix@example.com
    - sara@example.com
  Engineer:
    - ali@bevel.software
    - razvan@bevel.software
`;

describe('AccessControlService', () => {
  let root: string;
  const workspaceId = 'ws-access-1';

  beforeEach(async () => {
    root = await mkTmpRoot();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('admin-only baseline at root denies non-admin write', async () => {
    const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
    await writeFile(repo, 'roles.yaml', ROLES_YAML);
    await writeFile(repo, 'access.md', '---\nwrite:\n  - Admin\n---\n');

    const svc = new AccessControlService(stubWorkspaceService(workspaceId, workspaceDir), PROCESS_MAP_DIR);
    expect(await svc.canWrite(workspaceId, 'razvan@bevel.software', 'Knowledge/Foo.md')).toBe(true);
    expect(await svc.canWrite(workspaceId, 'felix@example.com', 'Knowledge/Foo.md')).toBe(false);
  });

  it("honors a `.tool` file's own frontmatter access verbs", async () => {
    const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
    await writeFile(repo, 'roles.yaml', ROLES_YAML);
    await writeFile(repo, 'access.md', '---\nwrite:\n  - Admin\n---\n');
    // A `.tool` carries its access verbs in a `---` frontmatter, read like a node's.
    await writeFile(
      repo,
      'Tools/weather.tool',
      '---\nid: weather\nwrite:\n  - Product Manager\n---\ntype: http\nurl: https://x/m\n',
    );

    const svc = new AccessControlService(stubWorkspaceService(workspaceId, workspaceDir), PROCESS_MAP_DIR);
    // The file-own `write: Product Manager` grants felix write on THIS tool…
    expect(await svc.canWrite(workspaceId, 'felix@example.com', 'Tools/weather.tool')).toBe(true);
    // …but nowhere else (root access.md is Admin-only).
    expect(await svc.canWrite(workspaceId, 'felix@example.com', 'Knowledge/Foo.md')).toBe(false);
    // Admin still writes it via the root rule.
    expect(await svc.canWrite(workspaceId, 'razvan@bevel.software', 'Tools/weather.tool')).toBe(true);
  });

  it('a deeper access.md broadens access only inside its subtree', async () => {
    const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
    await writeFile(repo, 'roles.yaml', ROLES_YAML);
    await writeFile(repo, 'access.md', '---\nwrite:\n  - Admin\n---\n');
    await writeFile(repo, 'Knowledge/Sales/access.md', '---\nwrite:\n  - Product Manager\n---\n');

    const svc = new AccessControlService(stubWorkspaceService(workspaceId, workspaceDir), PROCESS_MAP_DIR);
    expect(await svc.canWrite(workspaceId, 'felix@example.com', 'Knowledge/Sales/Foo.md')).toBe(true);
    expect(await svc.canWrite(workspaceId, 'felix@example.com', 'Knowledge/Other/Foo.md')).toBe(false);
    // Admin grant from root flows through.
    expect(await svc.canWrite(workspaceId, 'razvan@bevel.software', 'Knowledge/Sales/Foo.md')).toBe(true);
  });

  it('user-level deny trumps role-level grant', async () => {
    const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
    await writeFile(repo, 'roles.yaml', ROLES_YAML);
    await writeFile(repo, 'access.md', '---\nwrite:\n  - Admin\n---\n');
    await writeFile(
      repo,
      'Knowledge/Sales/access.md',
      '---\nwrite:\n  - Product Manager\n  - deny Felix Kissel <felix@example.com>\n---\n',
    );

    const svc = new AccessControlService(stubWorkspaceService(workspaceId, workspaceDir), PROCESS_MAP_DIR);
    expect(await svc.canWrite(workspaceId, 'felix@example.com', 'Knowledge/Sales/Foo.md')).toBe(false);
    expect(await svc.canWrite(workspaceId, 'sara@example.com', 'Knowledge/Sales/Foo.md')).toBe(true);
  });

  it('role denial does not undo unrelated role grant (Admin+Engineer with deny Engineer)', async () => {
    const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
    await writeFile(repo, 'roles.yaml', ROLES_YAML);
    await writeFile(repo, 'access.md', '---\nwrite:\n  - Admin\n  - deny Engineer\n---\n');

    const svc = new AccessControlService(stubWorkspaceService(workspaceId, workspaceDir), PROCESS_MAP_DIR);
    // razvan is both Admin and Engineer; Admin grant must still apply.
    expect(await svc.canWrite(workspaceId, 'razvan@bevel.software', 'Knowledge/Foo.md')).toBe(true);
    // ali is only Engineer — denied.
    expect(await svc.canWrite(workspaceId, 'ali@bevel.software', 'Knowledge/Foo.md')).toBe(false);
  });

  it('roles.yaml is editable only by Admin (hard-coded bypass)', async () => {
    const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
    await writeFile(repo, 'roles.yaml', ROLES_YAML);
    await writeFile(
      repo,
      'access.md',
      '---\nwrite:\n  - Admin\n  - Product Manager\n  - Engineer\n---\n',
    );

    const svc = new AccessControlService(stubWorkspaceService(workspaceId, workspaceDir), PROCESS_MAP_DIR);
    expect(await svc.canWrite(workspaceId, 'razvan@bevel.software', 'roles.yaml')).toBe(true);
    expect(await svc.canWrite(workspaceId, 'felix@example.com', 'roles.yaml')).toBe(false);
    expect(await svc.canWrite(workspaceId, 'ali@bevel.software', 'roles.yaml')).toBe(false);
  });

  it('canWriteBatch returns one entry per input path', async () => {
    const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
    await writeFile(repo, 'roles.yaml', ROLES_YAML);
    await writeFile(repo, 'access.md', '---\nwrite:\n  - Admin\n---\n');
    await writeFile(repo, 'Knowledge/Sales/access.md', '---\nwrite:\n  - Product Manager\n---\n');

    const svc = new AccessControlService(stubWorkspaceService(workspaceId, workspaceDir), PROCESS_MAP_DIR);
    const result = await svc.canWriteBatch(workspaceId, 'felix@example.com', [
      'Knowledge/Sales/A.md',
      'Knowledge/Other/B.md',
      'Knowledge/Sales/C.md',
    ]);
    expect(result.get('Knowledge/Sales/A.md')).toBe(true);
    expect(result.get('Knowledge/Other/B.md')).toBe(false);
    expect(result.get('Knowledge/Sales/C.md')).toBe(true);
  });

  it('built-in everyone grants non-read verbs without a roles.yaml entry', async () => {
    const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
    await writeFile(repo, 'roles.yaml', ROLES_YAML);
    await writeFile(
      repo,
      'access.md',
      '---\nwrite:\n  - everyone\ndownload:\n  - everyone\nowner:\n  - everyone\n---\n',
    );

    const svc = new AccessControlService(stubWorkspaceService(workspaceId, workspaceDir), PROCESS_MAP_DIR);
    expect(await svc.canWrite(workspaceId, 'nobody@example.com', 'Knowledge/Foo.md')).toBe(true);
    expect(await svc.canDownload(workspaceId, 'nobody@example.com', 'Knowledge/Foo.md')).toBe(true);
    expect(await svc.canOwner(workspaceId, 'nobody@example.com', 'Knowledge/Foo.md')).toBe(true);
    // read is granted via the implicit owner→read fold, not an explicit `read: everyone`.
    expect(await svc.canRead(workspaceId, 'nobody@example.com', 'Knowledge/Foo.md')).toBe(true);

    const writers = await svc.eligibleWriters(workspaceId, 'Knowledge/Foo.md');
    expect(writers.roles).toEqual(['everyone']);
  });

  it('deny everyone can narrow a non-read public grant', async () => {
    const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
    await writeFile(repo, 'roles.yaml', ROLES_YAML);
    await writeFile(repo, 'access.md', '---\nwrite:\n  - everyone\n---\n');
    await writeFile(
      repo,
      'Knowledge/Secret/access.md',
      '---\nwrite:\n  - deny everyone\n  - Product Manager\n---\n',
    );

    const svc = new AccessControlService(stubWorkspaceService(workspaceId, workspaceDir), PROCESS_MAP_DIR);
    expect(await svc.canWrite(workspaceId, 'nobody@example.com', 'Knowledge/Public.md')).toBe(true);
    expect(await svc.canWrite(workspaceId, 'nobody@example.com', 'Knowledge/Secret/Foo.md')).toBe(false);
    expect(await svc.canWrite(workspaceId, 'felix@example.com', 'Knowledge/Secret/Foo.md')).toBe(true);
  });

  it('a role denial is honoured under write: everyone (not just email denials)', async () => {
    const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
    await writeFile(repo, 'roles.yaml', ROLES_YAML);
    await writeFile(repo, 'access.md', '---\nwrite:\n  - everyone\n---\n');
    await writeFile(repo, 'Knowledge/Secret/access.md', '---\nwrite:\n  - deny Engineer\n---\n');

    const svc = new AccessControlService(stubWorkspaceService(workspaceId, workspaceDir), PROCESS_MAP_DIR);
    // everyone grants write at the root; a closer `deny Engineer` carves out
    // Engineers — a role-level denial, not an email one.
    expect(await svc.canWrite(workspaceId, 'nobody@example.com', 'Knowledge/Secret/Foo.md')).toBe(true);
    expect(await svc.canWrite(workspaceId, 'ali@bevel.software', 'Knowledge/Secret/Foo.md')).toBe(false);
  });

  it('closeness beats tier: a closer everyone grant overrides a farther email deny', async () => {
    const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
    await writeFile(repo, 'roles.yaml', ROLES_YAML);
    // Root denies felix read by name (the most specific tier).
    await writeFile(repo, 'access.md', '---\nread:\n  - Admin\n  - deny Felix Kissel <felix@example.com>\n---\n');
    // A closer scope opens the subtree to everyone (the least specific tier).
    await writeFile(repo, 'Knowledge/Open/access.md', '---\nread:\n  - everyone\n---\n');

    const svc = new AccessControlService(stubWorkspaceService(workspaceId, workspaceDir), PROCESS_MAP_DIR);
    // Closeness wins over tier: the closer `read: everyone` grant beats the
    // farther by-name deny.
    expect(await svc.canRead(workspaceId, 'felix@example.com', 'Knowledge/Open/Foo.md')).toBe(true);
    // Where only the root scope applies, the by-name deny still holds.
    expect(await svc.canRead(workspaceId, 'felix@example.com', 'Knowledge/Foo.md')).toBe(false);
  });

  it('write confers read (write ⊇ read), but deny write does not strip read', async () => {
    const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
    await writeFile(repo, 'roles.yaml', ROLES_YAML);
    // Engineers can write; ali alone is granted read. ali is an Engineer denied write.
    await writeFile(
      repo,
      'access.md',
      '---\nread:\n  - Ali <ali@bevel.software>\nwrite:\n  - Engineer\n  - deny Ali <ali@bevel.software>\n---\n',
    );

    const svc = new AccessControlService(stubWorkspaceService(workspaceId, workspaceDir), PROCESS_MAP_DIR);
    // razvan is an Engineer (write) and has no explicit read grant → can read
    // solely via the write ⊇ read fold.
    expect(await svc.canRead(workspaceId, 'razvan@bevel.software', 'Knowledge/Foo.md')).toBe(true);
    // ali is denied write, but the explicit `read` grant still applies — a write
    // denial must not fold down into a read denial.
    expect(await svc.canWrite(workspaceId, 'ali@bevel.software', 'Knowledge/Foo.md')).toBe(false);
    expect(await svc.canRead(workspaceId, 'ali@bevel.software', 'Knowledge/Foo.md')).toBe(true);
  });

  it('rejects roles.yaml definitions that use the built-in everyone role name', async () => {
    const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
    await writeFile(
      repo,
      'roles.yaml',
      `roles:
  Admin:
    - razvan@bevel.software
  Everyone:
    - felix@example.com
`,
    );
    await writeFile(repo, 'access.md', '---\nwrite:\n  - Admin\n---\n');

    const svc = new AccessControlService(stubWorkspaceService(workspaceId, workspaceDir), PROCESS_MAP_DIR);
    await expect(
      svc.canWrite(workspaceId, 'razvan@bevel.software', 'Knowledge/Foo.md'),
    ).rejects.toBeInstanceOf(AccessConfigError);
  });

  it('eligibleWriters lists role display names + direct user emails', async () => {
    const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
    await writeFile(repo, 'roles.yaml', ROLES_YAML);
    await writeFile(
      repo,
      'access.md',
      '---\nwrite:\n  - Admin\n  - Felix Kissel <felix@example.com>\n  - deny Engineer\n---\n',
    );

    const svc = new AccessControlService(stubWorkspaceService(workspaceId, workspaceDir), PROCESS_MAP_DIR);
    const e = await svc.eligibleWriters(workspaceId, 'Knowledge/Foo.md');
    expect(e.roles).toEqual(['Admin']);
    expect(e.users.map((u) => u.email)).toEqual(['felix@example.com']);
  });

  it('throws AccessConfigError when roles.yaml is missing', async () => {
    const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
    await writeFile(repo, 'access.md', '---\nwrite:\n  - Admin\n---\n');

    const svc = new AccessControlService(stubWorkspaceService(workspaceId, workspaceDir), PROCESS_MAP_DIR);
    await expect(
      svc.canWrite(workspaceId, 'razvan@bevel.software', 'Knowledge/Foo.md'),
    ).rejects.toBeInstanceOf(AccessConfigError);
  });

  it('drops unknown-role entries from access.md instead of throwing', async () => {
    // Previously: any unknown role ref made the whole loadModel throw
    // AccessConfigError → 500 on every access endpoint. This was a footgun
    // when roles.yaml retired a role still referenced by a deep access.md
    // (e.g. renaming Product Manager → Product Team). New behavior: drop
    // the entry with a warn log, keep the rest of the file. Admins still
    // get write on access.md via the rescue, so any wreckage stays
    // editable.
    const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
    await writeFile(repo, 'roles.yaml', ROLES_YAML);
    await writeFile(repo, 'access.md', '---\nwrite:\n  - Admin\n  - Ghost Role\n---\n');

    const svc = new AccessControlService(stubWorkspaceService(workspaceId, workspaceDir), PROCESS_MAP_DIR);
    // Admin grant survives the parse; Ghost Role entry is silently dropped.
    expect(await svc.canWrite(workspaceId, 'razvan@bevel.software', 'Knowledge/Foo.md')).toBe(true);
    expect(await svc.canWrite(workspaceId, 'felix@example.com', 'Knowledge/Foo.md')).toBe(false);
  });

  describe('canDownload', () => {
    it('returns true for an email granted download in the chain', async () => {
      const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
      await writeFile(repo, 'roles.yaml', ROLES_YAML);
      await writeFile(
        repo,
        'access.md',
        '---\nwrite:\n  - Admin\ndownload:\n  - Product Manager\n---\n',
      );

      const svc = new AccessControlService(stubWorkspaceService(workspaceId, workspaceDir), PROCESS_MAP_DIR);
      expect(await svc.canDownload(workspaceId, 'felix@example.com', 'Knowledge/Foo.md')).toBe(true);
      expect(await svc.canDownload(workspaceId, 'sara@example.com', 'Knowledge/Foo.md')).toBe(true);
    });

    it('returns false when the user has no download grant in the chain', async () => {
      const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
      await writeFile(repo, 'roles.yaml', ROLES_YAML);
      await writeFile(repo, 'access.md', '---\nwrite:\n  - Admin\ndownload:\n  - Admin\n---\n');

      const svc = new AccessControlService(stubWorkspaceService(workspaceId, workspaceDir), PROCESS_MAP_DIR);
      // ali is an Engineer; neither admin nor download.
      expect(await svc.canDownload(workspaceId, 'ali@bevel.software', 'Knowledge/Foo.md')).toBe(false);
      expect(await svc.canDownload(workspaceId, 'unknown@example.com', 'Knowledge/Foo.md')).toBe(false);
    });

    it('admin write access does NOT implicitly confer download', async () => {
      // Write and download are independent verbs in access.md. An admin can
      // edit a file they cannot download — load-bearing for the contract
      // that admins can't silently exfiltrate data they weren't granted
      // download on.
      const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
      await writeFile(repo, 'roles.yaml', ROLES_YAML);
      await writeFile(
        repo,
        'access.md',
        '---\nwrite:\n  - Admin\ndownload:\n  - Product Manager\n---\n',
      );

      const svc = new AccessControlService(stubWorkspaceService(workspaceId, workspaceDir), PROCESS_MAP_DIR);
      expect(await svc.canWrite(workspaceId, 'razvan@bevel.software', 'Knowledge/Foo.md')).toBe(true);
      expect(await svc.canDownload(workspaceId, 'razvan@bevel.software', 'Knowledge/Foo.md')).toBe(false);
    });

    it('inherits and broadens download down the directory chain', async () => {
      const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
      await writeFile(repo, 'roles.yaml', ROLES_YAML);
      await writeFile(repo, 'access.md', '---\nwrite:\n  - Admin\ndownload:\n  - Admin\n---\n');
      await writeFile(
        repo,
        'Knowledge/Sales/access.md',
        '---\ndownload:\n  - Product Manager\n---\n',
      );

      const svc = new AccessControlService(stubWorkspaceService(workspaceId, workspaceDir), PROCESS_MAP_DIR);
      expect(await svc.canDownload(workspaceId, 'felix@example.com', 'Knowledge/Sales/Foo.md')).toBe(true);
      expect(await svc.canDownload(workspaceId, 'felix@example.com', 'Knowledge/Other/Foo.md')).toBe(false);
    });

    it('returns false when no access.md declares a download grant', async () => {
      const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
      await writeFile(repo, 'roles.yaml', ROLES_YAML);
      // write only — no download verb anywhere in the tree.
      await writeFile(repo, 'access.md', '---\nwrite:\n  - Admin\n---\n');

      const svc = new AccessControlService(stubWorkspaceService(workspaceId, workspaceDir), PROCESS_MAP_DIR);
      expect(await svc.canDownload(workspaceId, 'razvan@bevel.software', 'Knowledge/Foo.md')).toBe(false);
    });

    it('throws AccessConfigError when roles.yaml is missing', async () => {
      // canDownload reuses loadModel, so the missing-roles.yaml failure
      // surfaces identically to canWrite. The download route catches and
      // routes through sendError so the caller sees the rich payload.
      const { workspaceDir } = await seedWorkspace(root, workspaceId);
      const svc = new AccessControlService(stubWorkspaceService(workspaceId, workspaceDir), PROCESS_MAP_DIR);
      await expect(svc.canDownload(workspaceId, 'razvan@bevel.software', 'Knowledge/Foo.md'))
        .rejects.toBeInstanceOf(AccessConfigError);
    });
  });

  describe('eligibleDownloaders', () => {
    it('lists role + user holders of an explicit download grant', async () => {
      const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
      await writeFile(repo, 'roles.yaml', ROLES_YAML);
      await writeFile(
        repo,
        'access.md',
        '---\nwrite:\n  - Admin\ndownload:\n  - Product Manager\n  - Ana <ana@example.com>\n---\n',
      );

      const svc = new AccessControlService(stubWorkspaceService(workspaceId, workspaceDir), PROCESS_MAP_DIR);
      const d = await svc.eligibleDownloaders(workspaceId, 'Knowledge/Foo.md');
      expect(d.roles).toEqual(['Product Manager']);
      expect(d.users.map((u) => u.email)).toEqual(['ana@example.com']);
    });

    it('folds owners into the download set (owner ⊇ download)', async () => {
      const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
      await writeFile(repo, 'roles.yaml', ROLES_YAML);
      await writeFile(
        repo,
        'access.md',
        '---\nowner:\n  - Product Manager\n---\n',
      );

      const svc = new AccessControlService(stubWorkspaceService(workspaceId, workspaceDir), PROCESS_MAP_DIR);
      const d = await svc.eligibleDownloaders(workspaceId, 'Knowledge/Foo.md');
      expect(d.roles).toEqual(['Product Manager']);
    });

    it('does NOT fold writers into the download set (write ⊉ download)', async () => {
      const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
      await writeFile(repo, 'roles.yaml', ROLES_YAML);
      await writeFile(repo, 'access.md', '---\nwrite:\n  - Admin\n---\n');

      const svc = new AccessControlService(stubWorkspaceService(workspaceId, workspaceDir), PROCESS_MAP_DIR);
      const d = await svc.eligibleDownloaders(workspaceId, 'Knowledge/Foo.md');
      expect(d.roles).toEqual([]);
      expect(d.users).toEqual([]);
    });

    it('surfaces a download:everyone grant as the everyone role', async () => {
      const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
      await writeFile(repo, 'roles.yaml', ROLES_YAML);
      await writeFile(repo, 'access.md', '---\ndownload:\n  - everyone\n---\n');

      const svc = new AccessControlService(stubWorkspaceService(workspaceId, workspaceDir), PROCESS_MAP_DIR);
      const d = await svc.eligibleDownloaders(workspaceId, 'Knowledge/Foo.md');
      expect(d.roles).toContain('everyone');
    });
  });

  describe('owner verb', () => {
    it('an owner grant confers both write and download', async () => {
      const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
      await writeFile(repo, 'roles.yaml', ROLES_YAML);
      // Admin writes; Product Manager is only an owner (no explicit write/download).
      await writeFile(
        repo,
        'access.md',
        '---\nwrite:\n  - Admin\nowner:\n  - Product Manager\n---\n',
      );

      const svc = new AccessControlService(stubWorkspaceService(workspaceId, workspaceDir), PROCESS_MAP_DIR);
      // felix is a Product Manager → owner → both write and download.
      expect(await svc.canWrite(workspaceId, 'felix@example.com', 'Knowledge/Foo.md')).toBe(true);
      expect(await svc.canDownload(workspaceId, 'felix@example.com', 'Knowledge/Foo.md')).toBe(true);
      expect(await svc.canOwner(workspaceId, 'felix@example.com', 'Knowledge/Foo.md')).toBe(true);
    });

    it('a plain writer is not an owner', async () => {
      const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
      await writeFile(repo, 'roles.yaml', ROLES_YAML);
      await writeFile(repo, 'access.md', '---\nwrite:\n  - Admin\nowner:\n  - Product Manager\n---\n');

      const svc = new AccessControlService(stubWorkspaceService(workspaceId, workspaceDir), PROCESS_MAP_DIR);
      // razvan (Admin) can write but is not designated an owner here.
      expect(await svc.canWrite(workspaceId, 'razvan@bevel.software', 'Knowledge/Foo.md')).toBe(true);
      expect(await svc.canOwner(workspaceId, 'razvan@bevel.software', 'Knowledge/Foo.md')).toBe(false);
    });

    it('owners are folded into the write-eligibility (approval) set', async () => {
      const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
      await writeFile(repo, 'roles.yaml', ROLES_YAML);
      await writeFile(
        repo,
        'access.md',
        '---\nwrite:\n  - Admin\nowner:\n  - Sara Lee <sara@example.com>\n---\n',
      );

      const svc = new AccessControlService(stubWorkspaceService(workspaceId, workspaceDir), PROCESS_MAP_DIR);
      const writers = await svc.eligibleWriters(workspaceId, 'Knowledge/Foo.md');
      // Admin role (write) + the owner user both appear — owners can approve.
      expect(writers.roles).toEqual(['Admin']);
      expect(writers.users.map((u) => u.email)).toEqual(['sara@example.com']);
    });

    it('eligibleOwners reports only owners, not plain writers', async () => {
      const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
      await writeFile(repo, 'roles.yaml', ROLES_YAML);
      await writeFile(
        repo,
        'access.md',
        '---\nwrite:\n  - Admin\nowner:\n  - Product Manager\n  - Sara Lee <sara@example.com>\n---\n',
      );

      const svc = new AccessControlService(stubWorkspaceService(workspaceId, workspaceDir), PROCESS_MAP_DIR);
      const owners = await svc.eligibleOwners(workspaceId, 'Knowledge/Foo.md');
      expect(owners.roles).toEqual(['Product Manager']);
      expect(owners.users.map((u) => u.email)).toEqual(['sara@example.com']);
    });

    it('owner folds in down the directory chain like other verbs', async () => {
      const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
      await writeFile(repo, 'roles.yaml', ROLES_YAML);
      await writeFile(repo, 'access.md', '---\nwrite:\n  - Admin\n---\n');
      await writeFile(
        repo,
        'Knowledge/Sales/access.md',
        '---\nowner:\n  - Product Manager\n---\n',
      );

      const svc = new AccessControlService(stubWorkspaceService(workspaceId, workspaceDir), PROCESS_MAP_DIR);
      // felix owns inside Sales → can write + download there, but not elsewhere.
      expect(await svc.canWrite(workspaceId, 'felix@example.com', 'Knowledge/Sales/Foo.md')).toBe(true);
      expect(await svc.canDownload(workspaceId, 'felix@example.com', 'Knowledge/Sales/Foo.md')).toBe(true);
      expect(await svc.canWrite(workspaceId, 'felix@example.com', 'Knowledge/Other/Foo.md')).toBe(false);
    });
  });

  describe('per-file frontmatter permissions', () => {
    const NODE = (verbBlock: string) =>
      `---\nnodeType: "[Process](../../NodeTypes/Process.md)"\n${verbBlock}---\n\n# Foo\n`;

    it("a node's own owner: frontmatter grants write+download+owner for that file only", async () => {
      const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
      await writeFile(repo, 'roles.yaml', ROLES_YAML);
      // Folder grants only Admin write; felix (Product Manager) has nothing here.
      await writeFile(repo, 'access.md', '---\nwrite:\n  - Admin\n---\n');
      await writeFile(repo, 'Knowledge/Sales/Foo.md', NODE('owner:\n  - Product Manager\n'));
      await writeFile(repo, 'Knowledge/Sales/Bar.md', NODE(''));

      const svc = new AccessControlService(stubWorkspaceService(workspaceId, workspaceDir), PROCESS_MAP_DIR);
      // Foo's own owner: grant lifts felix to write + download + owner there.
      expect(await svc.canWrite(workspaceId, 'felix@example.com', 'Knowledge/Sales/Foo.md')).toBe(true);
      expect(await svc.canDownload(workspaceId, 'felix@example.com', 'Knowledge/Sales/Foo.md')).toBe(true);
      expect(await svc.canOwner(workspaceId, 'felix@example.com', 'Knowledge/Sales/Foo.md')).toBe(true);
      // A sibling without per-file perms still follows the folder rule (Admin only).
      expect(await svc.canWrite(workspaceId, 'felix@example.com', 'Knowledge/Sales/Bar.md')).toBe(false);
    });

    it('accepts the single-value scalar form: `owner: Test <test@test.com>`', async () => {
      const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
      await writeFile(repo, 'roles.yaml', ROLES_YAML);
      await writeFile(repo, 'access.md', '---\nwrite:\n  - Admin\n---\n');
      // Scalar (not a list) — the natural way to name one owner in a node.
      await writeFile(repo, 'NodeTypes/Process.md', NODE('owner: Test <test@test.com>\n'));

      const svc = new AccessControlService(stubWorkspaceService(workspaceId, workspaceDir), PROCESS_MAP_DIR);
      expect(await svc.canWrite(workspaceId, 'test@test.com', 'NodeTypes/Process.md')).toBe(true);
      expect(await svc.canDownload(workspaceId, 'test@test.com', 'NodeTypes/Process.md')).toBe(true);
      expect(await svc.canOwner(workspaceId, 'test@test.com', 'NodeTypes/Process.md')).toBe(true);
      const owners = await svc.eligibleOwners(workspaceId, 'NodeTypes/Process.md');
      expect(owners.users.map((u) => u.email)).toEqual(['test@test.com']);
    });

    it('accepts the scalar form for write: and download: too', async () => {
      const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
      await writeFile(repo, 'roles.yaml', ROLES_YAML);
      await writeFile(repo, 'access.md', '---\nwrite:\n  - Admin\n---\n');
      await writeFile(repo, 'Knowledge/W.md', NODE('write: Product Manager\n'));
      await writeFile(repo, 'Knowledge/D.md', NODE('download: Felix Kissel <felix@example.com>\n'));

      const svc = new AccessControlService(stubWorkspaceService(workspaceId, workspaceDir), PROCESS_MAP_DIR);
      expect(await svc.canWrite(workspaceId, 'felix@example.com', 'Knowledge/W.md')).toBe(true);
      // write scalar does not confer download
      expect(await svc.canDownload(workspaceId, 'felix@example.com', 'Knowledge/W.md')).toBe(false);
      expect(await svc.canDownload(workspaceId, 'felix@example.com', 'Knowledge/D.md')).toBe(true);
    });

    it("a node's own write: frontmatter grants write only (not download)", async () => {
      const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
      await writeFile(repo, 'roles.yaml', ROLES_YAML);
      await writeFile(repo, 'access.md', '---\nwrite:\n  - Admin\n---\n');
      await writeFile(repo, 'Knowledge/Foo.md', NODE('write:\n  - Product Manager\n'));

      const svc = new AccessControlService(stubWorkspaceService(workspaceId, workspaceDir), PROCESS_MAP_DIR);
      expect(await svc.canWrite(workspaceId, 'felix@example.com', 'Knowledge/Foo.md')).toBe(true);
      expect(await svc.canDownload(workspaceId, 'felix@example.com', 'Knowledge/Foo.md')).toBe(false);
      expect(await svc.canOwner(workspaceId, 'felix@example.com', 'Knowledge/Foo.md')).toBe(false);
    });

    it("a node's own deny tightens access for just that file", async () => {
      const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
      await writeFile(repo, 'roles.yaml', ROLES_YAML);
      await writeFile(repo, 'access.md', '---\nwrite:\n  - Admin\n---\n');
      // Folder grants Product Manager write; Foo.md revokes it for itself.
      await writeFile(repo, 'Knowledge/Sales/access.md', '---\nwrite:\n  - Product Manager\n---\n');
      await writeFile(repo, 'Knowledge/Sales/Foo.md', NODE('write:\n  - deny Product Manager\n'));
      await writeFile(repo, 'Knowledge/Sales/Bar.md', NODE(''));

      const svc = new AccessControlService(stubWorkspaceService(workspaceId, workspaceDir), PROCESS_MAP_DIR);
      expect(await svc.canWrite(workspaceId, 'felix@example.com', 'Knowledge/Sales/Foo.md')).toBe(false);
      // Sibling still inherits the folder grant.
      expect(await svc.canWrite(workspaceId, 'felix@example.com', 'Knowledge/Sales/Bar.md')).toBe(true);
    });

    it('per-file owners are folded into eligibleWriters and reported by eligibleOwners', async () => {
      const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
      await writeFile(repo, 'roles.yaml', ROLES_YAML);
      await writeFile(repo, 'access.md', '---\nwrite:\n  - Admin\n---\n');
      await writeFile(
        repo,
        'Knowledge/Foo.md',
        NODE('owner:\n  - Sara Lee <sara@example.com>\n'),
      );

      const svc = new AccessControlService(stubWorkspaceService(workspaceId, workspaceDir), PROCESS_MAP_DIR);
      const writers = await svc.eligibleWriters(workspaceId, 'Knowledge/Foo.md');
      // Admin (folder write) + the per-file owner can both approve this file.
      expect(writers.roles).toEqual(['Admin']);
      expect(writers.users.map((u) => u.email)).toEqual(['sara@example.com']);

      const owners = await svc.eligibleOwners(workspaceId, 'Knowledge/Foo.md');
      expect(owners.roles).toEqual([]);
      expect(owners.users.map((u) => u.email)).toEqual(['sara@example.com']);
    });

    it('ignores non-access frontmatter keys (a plain typed node is unaffected)', async () => {
      const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
      await writeFile(repo, 'roles.yaml', ROLES_YAML);
      await writeFile(repo, 'access.md', '---\nwrite:\n  - Admin\n---\n');
      // Only nodeType in frontmatter — no access verbs → folder rule applies.
      await writeFile(repo, 'Knowledge/Foo.md', NODE(''));

      const svc = new AccessControlService(stubWorkspaceService(workspaceId, workspaceDir), PROCESS_MAP_DIR);
      expect(await svc.canWrite(workspaceId, 'razvan@bevel.software', 'Knowledge/Foo.md')).toBe(true);
      expect(await svc.canWrite(workspaceId, 'felix@example.com', 'Knowledge/Foo.md')).toBe(false);
    });

    it('a file with NO frontmatter at all is fine — folder rules apply, no error', async () => {
      const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
      await writeFile(repo, 'roles.yaml', ROLES_YAML);
      await writeFile(repo, 'access.md', '---\nwrite:\n  - Admin\ndownload:\n  - Admin\n---\n');
      // Plain free-form note — no leading `---` block whatsoever.
      await writeFile(repo, 'Knowledge/Plain.md', '# Just a note\n\nSome prose, no frontmatter.\n');

      const svc = new AccessControlService(stubWorkspaceService(workspaceId, workspaceDir), PROCESS_MAP_DIR);
      // Folder rule (Admin) still governs; no per-file override, no throw.
      expect(await svc.canWrite(workspaceId, 'razvan@bevel.software', 'Knowledge/Plain.md')).toBe(true);
      expect(await svc.canWrite(workspaceId, 'felix@example.com', 'Knowledge/Plain.md')).toBe(false);
      expect(await svc.canDownload(workspaceId, 'razvan@bevel.software', 'Knowledge/Plain.md')).toBe(true);
      expect(await svc.canOwner(workspaceId, 'razvan@bevel.software', 'Knowledge/Plain.md')).toBe(false);
    });

    it('a missing file (path not on disk) resolves to folder rules without throwing', async () => {
      const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
      await writeFile(repo, 'roles.yaml', ROLES_YAML);
      await writeFile(repo, 'access.md', '---\nwrite:\n  - Admin\n---\n');

      const svc = new AccessControlService(stubWorkspaceService(workspaceId, workspaceDir), PROCESS_MAP_DIR);
      // No Ghost.md on disk — readOwnEntries swallows the ENOENT and falls back.
      expect(await svc.canWrite(workspaceId, 'razvan@bevel.software', 'Knowledge/Ghost.md')).toBe(true);
      expect(await svc.canWrite(workspaceId, 'felix@example.com', 'Knowledge/Ghost.md')).toBe(false);
    });
  });

  describe('forgiving access.md parsing', () => {
    it('ignores unknown verbs and still parses the known ones', async () => {
      const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
      await writeFile(repo, 'roles.yaml', ROLES_YAML);
      // `archive:` is a made-up verb. Must not crash; `write:` still applies.
      await writeFile(
        repo,
        'access.md',
        '---\nwrite:\n  - Admin\narchive:\n  - Admin\nnotes: skip-me\n---\n',
      );

      const svc = new AccessControlService(stubWorkspaceService(workspaceId, workspaceDir), PROCESS_MAP_DIR);
      expect(await svc.canWrite(workspaceId, 'razvan@bevel.software', 'Knowledge/Foo.md')).toBe(true);
      expect(await svc.canWrite(workspaceId, 'felix@example.com', 'Knowledge/Foo.md')).toBe(false);
    });

    it('skips an access.md that references an unknown role (no longer throws)', async () => {
      // Previously this would throw `AccessConfigError` and 500 every
      // access endpoint. New behavior: warn + drop the offending entry,
      // keep the rest of the file. Admins can still rescue.
      const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
      await writeFile(repo, 'roles.yaml', ROLES_YAML);
      await writeFile(
        repo,
        'access.md',
        '---\nwrite:\n  - Admin\n  - Ghost Role\n---\n',
      );

      const svc = new AccessControlService(stubWorkspaceService(workspaceId, workspaceDir), PROCESS_MAP_DIR);
      // Admin still has write (Ghost Role entry was dropped, Admin remained).
      expect(await svc.canWrite(workspaceId, 'razvan@bevel.software', 'Knowledge/Foo.md')).toBe(true);
    });

    it('skips a structurally malformed access.md instead of throwing', async () => {
      // Bad YAML inside the frontmatter must not 500 the whole tree —
      // admins need to remain able to edit access.md to fix it.
      const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
      await writeFile(repo, 'roles.yaml', ROLES_YAML);
      await writeFile(repo, 'access.md', '---\nwrite: not-a-list\n---\n');

      const svc = new AccessControlService(stubWorkspaceService(workspaceId, workspaceDir), PROCESS_MAP_DIR);
      // Default-deny for non-admins on the rest of the tree (no rules in force),
      // but admins keep their rescue.
      expect(await svc.canWrite(workspaceId, 'razvan@bevel.software', 'access.md')).toBe(true);
      expect(await svc.canWrite(workspaceId, 'felix@example.com', 'Knowledge/Foo.md')).toBe(false);
    });
  });

  describe('admin rescue on access.md', () => {
    it('admins can always write access.md even if it excludes them', async () => {
      // Without the admin rescue, a config that omits Admin from write
      // would lock everyone — including admins — out of fixing it.
      const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
      await writeFile(repo, 'roles.yaml', ROLES_YAML);
      // Note: Admin NOT in write list.
      await writeFile(repo, 'access.md', '---\nwrite:\n  - Product Manager\n---\n');

      const svc = new AccessControlService(stubWorkspaceService(workspaceId, workspaceDir), PROCESS_MAP_DIR);
      expect(await svc.canWrite(workspaceId, 'razvan@bevel.software', 'access.md')).toBe(true);
      // Non-admins still gated normally.
      expect(await svc.canWrite(workspaceId, 'ali@bevel.software', 'access.md')).toBe(false);
    });

    it('admin rescue extends to nested access.md files at any depth', async () => {
      const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
      await writeFile(repo, 'roles.yaml', ROLES_YAML);
      await writeFile(repo, 'access.md', '---\nwrite:\n  - Admin\n---\n');
      // Nested access.md that excludes Admin.
      await writeFile(
        repo,
        'Knowledge/Sales/access.md',
        '---\nwrite:\n  - Product Manager\n---\n',
      );

      const svc = new AccessControlService(stubWorkspaceService(workspaceId, workspaceDir), PROCESS_MAP_DIR);
      expect(await svc.canWrite(workspaceId, 'razvan@bevel.software', 'Knowledge/Sales/access.md')).toBe(true);
    });

    it('admin rescue does NOT apply to download — only to write on access.md / roles.yaml', async () => {
      const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
      await writeFile(repo, 'roles.yaml', ROLES_YAML);
      await writeFile(repo, 'access.md', '---\nwrite:\n  - Admin\ndownload:\n  - Product Manager\n---\n');

      const svc = new AccessControlService(stubWorkspaceService(workspaceId, workspaceDir), PROCESS_MAP_DIR);
      // Admin still can't download access.md — they aren't listed under download.
      expect(await svc.canDownload(workspaceId, 'razvan@bevel.software', 'access.md')).toBe(false);
    });
  });

  it('caches the model and re-reads after invalidate()', async () => {
    const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
    await writeFile(repo, 'roles.yaml', ROLES_YAML);
    await writeFile(repo, 'access.md', '---\nwrite:\n  - Admin\n---\n');

    const svc = new AccessControlService(stubWorkspaceService(workspaceId, workspaceDir), PROCESS_MAP_DIR);
    expect(await svc.canWrite(workspaceId, 'felix@example.com', 'Knowledge/Foo.md')).toBe(false);

    // Broaden access — but cache will still say false until we invalidate.
    await writeFile(repo, 'access.md', '---\nwrite:\n  - Admin\n  - Product Manager\n---\n');
    expect(await svc.canWrite(workspaceId, 'felix@example.com', 'Knowledge/Foo.md')).toBe(false);

    svc.invalidate(workspaceId);
    expect(await svc.canWrite(workspaceId, 'felix@example.com', 'Knowledge/Foo.md')).toBe(true);
  });

  describe('read verb', () => {
    it('default-deny: with no read: or owner grant, nobody can read', async () => {
      const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
      await writeFile(repo, 'roles.yaml', ROLES_YAML);
      await writeFile(repo, 'access.md', '---\nwrite:\n  - Admin\n---\n');

      const svc = new AccessControlService(stubWorkspaceService(workspaceId, workspaceDir), PROCESS_MAP_DIR);
      expect(await svc.canRead(workspaceId, 'felix@example.com', 'Knowledge/Foo.md')).toBe(false);
      expect(await svc.canRead(workspaceId, 'nobody@example.com', 'Knowledge/Foo.md')).toBe(false);
      // razvan is Admin, so the root `write: Admin` confers read (write ⊇ read).
      expect(await svc.canRead(workspaceId, 'razvan@bevel.software', 'Knowledge/Foo.md')).toBe(true);
    });

    it('read: everyone grants read to all users without a roles.yaml entry', async () => {
      const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
      await writeFile(repo, 'roles.yaml', ROLES_YAML);
      await writeFile(repo, 'access.md', '---\nwrite:\n  - Admin\nread:\n  - everyone\n---\n');

      const svc = new AccessControlService(stubWorkspaceService(workspaceId, workspaceDir), PROCESS_MAP_DIR);
      expect(await svc.canRead(workspaceId, 'felix@example.com', 'Knowledge/Foo.md')).toBe(true);
      expect(await svc.canRead(workspaceId, 'nobody@example.com', 'Knowledge/Foo.md')).toBe(true);
    });

    it('a closer role-level deny overrides a farther read: everyone grant', async () => {
      const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
      await writeFile(repo, 'roles.yaml', ROLES_YAML);
      // Parent grants everyone read; a child access.md denies the Product
      // Manager role. Resolution is closeness-first then tier (email > role >
      // everyone within a scope): the child scope is closer, and its role-level
      // deny is decided there before the farther everyone grant is reached.
      await writeFile(repo, 'access.md', '---\nwrite:\n  - Admin\nread:\n  - everyone\n---\n');
      await writeFile(repo, 'Knowledge/Secret/access.md', '---\nread:\n  - deny Product Manager\n---\n');

      const svc = new AccessControlService(stubWorkspaceService(workspaceId, workspaceDir), PROCESS_MAP_DIR);
      // felix is a Product Manager, denied at the closer child scope → no read.
      expect(await svc.canRead(workspaceId, 'felix@example.com', 'Knowledge/Secret/Foo.md')).toBe(false);
      // A user with no roles has no verdict at the child scope, so resolution
      // falls through to the farther everyone grant → still reads.
      expect(await svc.canRead(workspaceId, 'nobody@example.com', 'Knowledge/Secret/Foo.md')).toBe(true);
    });

    it('a read: list restricts the subtree to the named principals', async () => {
      const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
      await writeFile(repo, 'roles.yaml', ROLES_YAML);
      await writeFile(repo, 'access.md', '---\nwrite:\n  - Admin\n---\n');
      await writeFile(repo, 'Knowledge/Sales/access.md', '---\nread:\n  - Product Manager\n---\n');

      const svc = new AccessControlService(stubWorkspaceService(workspaceId, workspaceDir), PROCESS_MAP_DIR);
      // Inside the restricted subtree: only Product Managers may read.
      expect(await svc.canRead(workspaceId, 'felix@example.com', 'Knowledge/Sales/Foo.md')).toBe(true);
      expect(await svc.canRead(workspaceId, 'ali@bevel.software', 'Knowledge/Sales/Foo.md')).toBe(false);
      // Outside the subtree the default-deny baseline still holds.
      expect(await svc.canRead(workspaceId, 'ali@bevel.software', 'Knowledge/Other/Foo.md')).toBe(false);
    });

    it('deny everyone can close a subtree below a public root', async () => {
      const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
      await writeFile(repo, 'roles.yaml', ROLES_YAML);
      await writeFile(repo, 'access.md', '---\nwrite:\n  - Admin\nread:\n  - everyone\n---\n');
      await writeFile(
        repo,
        'Knowledge/Secret/access.md',
        '---\nread:\n  - deny everyone\n  - Product Manager\n---\n',
      );

      const svc = new AccessControlService(stubWorkspaceService(workspaceId, workspaceDir), PROCESS_MAP_DIR);
      expect(await svc.canRead(workspaceId, 'nobody@example.com', 'Knowledge/Public.md')).toBe(true);
      expect(await svc.canRead(workspaceId, 'ali@bevel.software', 'Knowledge/Secret/Foo.md')).toBe(false);
      expect(await svc.canRead(workspaceId, 'felix@example.com', 'Knowledge/Secret/Foo.md')).toBe(true);
    });

    it("a directory's own access.md read: rule governs the directory node itself", async () => {
      const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
      await writeFile(repo, 'roles.yaml', ROLES_YAML);
      await writeFile(repo, 'access.md', '---\nwrite:\n  - Admin\n---\n');
      await writeFile(repo, 'Knowledge/Secret/access.md', '---\nread:\n  - Product Manager\n---\n');

      const svc = new AccessControlService(stubWorkspaceService(workspaceId, workspaceDir), PROCESS_MAP_DIR);
      // The leaf directory is included in the chain, so its own access.md applies
      // to the folder node — not just to files beneath it.
      expect(await svc.canRead(workspaceId, 'felix@example.com', 'Knowledge/Secret')).toBe(true);
      expect(await svc.canRead(workspaceId, 'ali@bevel.software', 'Knowledge/Secret')).toBe(false);
    });

    it('an owner grant confers read on a read-restricted node', async () => {
      const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
      await writeFile(repo, 'roles.yaml', ROLES_YAML);
      // Root restricts read to Admin, but names felix as an owner.
      await writeFile(
        repo,
        'access.md',
        '---\nwrite:\n  - Admin\nread:\n  - Admin\nowner:\n  - Felix Kissel <felix@example.com>\n---\n',
      );

      const svc = new AccessControlService(stubWorkspaceService(workspaceId, workspaceDir), PROCESS_MAP_DIR);
      expect(await svc.canRead(workspaceId, 'felix@example.com', 'Knowledge/Foo.md')).toBe(true); // owner → read
      expect(await svc.canRead(workspaceId, 'razvan@bevel.software', 'Knowledge/Foo.md')).toBe(true); // Admin
      expect(await svc.canRead(workspaceId, 'sara@example.com', 'Knowledge/Foo.md')).toBe(false); // neither
    });

    it('user-level deny in read: trumps a role grant', async () => {
      const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
      await writeFile(repo, 'roles.yaml', ROLES_YAML);
      await writeFile(
        repo,
        'access.md',
        '---\nwrite:\n  - Admin\nread:\n  - Product Manager\n  - deny Felix Kissel <felix@example.com>\n---\n',
      );

      const svc = new AccessControlService(stubWorkspaceService(workspaceId, workspaceDir), PROCESS_MAP_DIR);
      expect(await svc.canRead(workspaceId, 'felix@example.com', 'Knowledge/Foo.md')).toBe(false);
      expect(await svc.canRead(workspaceId, 'sara@example.com', 'Knowledge/Foo.md')).toBe(true);
    });

    it('no admin rescue for read — admins read a restricted node only if listed', async () => {
      const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
      await writeFile(repo, 'roles.yaml', ROLES_YAML);
      // Write/read restricted to Product Manager — Admin is neither listed nor a
      // writer here, so there's no rescue path to read (unlike write on access.md).
      await writeFile(repo, 'access.md', '---\nwrite:\n  - Product Manager\nread:\n  - Product Manager\n---\n');

      const svc = new AccessControlService(stubWorkspaceService(workspaceId, workspaceDir), PROCESS_MAP_DIR);
      // razvan is Admin but not a Product Manager — restricted read denies him.
      expect(await svc.canRead(workspaceId, 'razvan@bevel.software', 'Knowledge/Foo.md')).toBe(false);
    });

    it("a node's own read: frontmatter grants just that file", async () => {
      const NODE = (verbBlock: string) =>
        `---\nnodeType: "[Process](../../NodeTypes/Process.md)"\n${verbBlock}---\n\n# Foo\n`;
      const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
      await writeFile(repo, 'roles.yaml', ROLES_YAML);
      await writeFile(repo, 'access.md', '---\nwrite:\n  - Admin\n---\n');
      await writeFile(repo, 'Knowledge/Secret.md', NODE('read:\n  - Product Manager\n'));
      await writeFile(repo, 'Knowledge/Plain.md', NODE(''));

      const svc = new AccessControlService(stubWorkspaceService(workspaceId, workspaceDir), PROCESS_MAP_DIR);
      expect(await svc.canRead(workspaceId, 'felix@example.com', 'Knowledge/Secret.md')).toBe(true);
      expect(await svc.canRead(workspaceId, 'ali@bevel.software', 'Knowledge/Secret.md')).toBe(false);
      // The sibling without a read: rule remains default-denied.
      expect(await svc.canRead(workspaceId, 'ali@bevel.software', 'Knowledge/Plain.md')).toBe(false);
    });

    it('canReadBatch returns one entry per input path', async () => {
      const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
      await writeFile(repo, 'roles.yaml', ROLES_YAML);
      await writeFile(repo, 'access.md', '---\nwrite:\n  - Admin\n---\n');
      await writeFile(repo, 'Knowledge/Sales/access.md', '---\nread:\n  - Product Manager\n---\n');

      const svc = new AccessControlService(stubWorkspaceService(workspaceId, workspaceDir), PROCESS_MAP_DIR);
      const result = await svc.canReadBatch(workspaceId, 'ali@bevel.software', [
        'Knowledge/Open.md',
        'Knowledge/Sales/Restricted.md',
      ]);
      expect(result.get('Knowledge/Open.md')).toBe(false); // no read grant
      expect(result.get('Knowledge/Sales/Restricted.md')).toBe(false); // restricted, ali not a PM
    });

    it('canReadBatch evaluates each path independently (mixed results)', async () => {
      const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
      await writeFile(repo, 'roles.yaml', ROLES_YAML);
      await writeFile(repo, 'access.md', '---\nwrite:\n  - Admin\nread:\n  - everyone\n---\n');
      await writeFile(repo, 'Knowledge/Sales/access.md', '---\nread:\n  - deny everyone\n  - Product Manager\n---\n');

      const svc = new AccessControlService(stubWorkspaceService(workspaceId, workspaceDir), PROCESS_MAP_DIR);
      const result = await svc.canReadBatch(workspaceId, 'ali@bevel.software', [
        'Knowledge/Open.md',
        'Knowledge/Sales/Restricted.md',
      ]);
      expect(result.get('Knowledge/Open.md')).toBe(true); // read: everyone
      expect(result.get('Knowledge/Sales/Restricted.md')).toBe(false); // deny everyone, ali not a PM
    });

    describe('eligibleReaders', () => {
      it('reports restricted=true with no readers for a default-denied node', async () => {
        const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
        await writeFile(repo, 'roles.yaml', ROLES_YAML);
        // Only `download` is granted — it does not confer read (read ⊄ download),
        // so no principal can read this node.
        await writeFile(repo, 'access.md', '---\ndownload:\n  - Admin\n---\n');

        const svc = new AccessControlService(stubWorkspaceService(workspaceId, workspaceDir), PROCESS_MAP_DIR);
        const e = await svc.eligibleReaders(workspaceId, 'Knowledge/Foo.md');
        expect(e).toEqual({ restricted: true, roles: [], users: [] });
      });

      it('reports restricted=false when read: everyone applies', async () => {
        const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
        await writeFile(repo, 'roles.yaml', ROLES_YAML);
        await writeFile(repo, 'access.md', '---\nwrite:\n  - Admin\nread:\n  - everyone\n---\n');

        const svc = new AccessControlService(stubWorkspaceService(workspaceId, workspaceDir), PROCESS_MAP_DIR);
        const e = await svc.eligibleReaders(workspaceId, 'Knowledge/Foo.md');
        expect(e).toEqual({ restricted: false, roles: [], users: [] });
      });

      it('restricted=false when a closer everyone grant shadows a farther by-name deny', async () => {
        const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
        await writeFile(repo, 'roles.yaml', ROLES_YAML);
        // Root denies felix by name, but a closer scope opens the subtree to all.
        await writeFile(repo, 'access.md', '---\nread:\n  - deny Felix Kissel <felix@example.com>\n---\n');
        await writeFile(repo, 'Knowledge/Open/access.md', '---\nread:\n  - everyone\n---\n');

        const svc = new AccessControlService(stubWorkspaceService(workspaceId, workspaceDir), PROCESS_MAP_DIR);
        // felix actually reads here (the closer everyone grant wins), so the
        // node really is readable by everyone — not restricted.
        expect(await svc.canRead(workspaceId, 'felix@example.com', 'Knowledge/Open/Foo.md')).toBe(true);
        const e = await svc.eligibleReaders(workspaceId, 'Knowledge/Open/Foo.md');
        expect(e).toEqual({ restricted: false, roles: [], users: [] });
      });

      it('restricted=true when a same-scope by-name deny carves someone out of read: everyone', async () => {
        const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
        await writeFile(repo, 'roles.yaml', ROLES_YAML);
        await writeFile(
          repo,
          'access.md',
          '---\nread:\n  - everyone\n  - deny Felix Kissel <felix@example.com>\n---\n',
        );

        const svc = new AccessControlService(stubWorkspaceService(workspaceId, workspaceDir), PROCESS_MAP_DIR);
        // felix is carved out (email tier beats everyone within the scope), so
        // it's not readable by *everyone*.
        expect(await svc.canRead(workspaceId, 'felix@example.com', 'Knowledge/Foo.md')).toBe(false);
        expect((await svc.eligibleReaders(workspaceId, 'Knowledge/Foo.md')).restricted).toBe(true);
      });

      it('lists the reader principals (owners folded in) for a restricted node', async () => {
        const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
        await writeFile(repo, 'roles.yaml', ROLES_YAML);
        await writeFile(
          repo,
          'access.md',
          '---\nwrite:\n  - Admin\nread:\n  - Product Manager\nowner:\n  - Ada Lovelace <ada@example.com>\n---\n',
        );

        const svc = new AccessControlService(stubWorkspaceService(workspaceId, workspaceDir), PROCESS_MAP_DIR);
        const e = await svc.eligibleReaders(workspaceId, 'Knowledge/Foo.md');
        expect(e.restricted).toBe(true);
        expect(e.roles).toContain('Product Manager');
        expect(e.users.map((u) => u.email)).toContain('ada@example.com'); // owner reads
      });
    });
  });

  /**
   * The deployment owner (`ADMIN_EMAIL`) as a rescue path.
   *
   * `roles.yaml` is Admin-only by a hardcoded rule, and "Admin" used to mean
   * the `Admin` role in `roles.yaml` and nothing else. That makes the file
   * self-sealing: a roles.yaml that loses its last Admin — a bad merge, a
   * renamed address, a restored backup — can then be repaired only by
   * committing to the KB repo by hand, because the one file that decides who
   * may fix it is the one file nobody may write.
   *
   * It also disagreed with `AdminAccessService`, which was already given the
   * same owner list: the owner saw every admin surface and was refused the
   * save, with the UI calling them an admin and the gate answering
   * "Eligible: Admin".
   */
  describe('deployment owner (ADMIN_EMAIL)', () => {
    const OWNER = 'owner@bevel.software';
    /** roles.yaml with an Admin that is NOT the deployment owner. */
    const ROLES_WITHOUT_OWNER = `roles:
  Admin:
    - someone-else@example.com
`;

    async function seeded() {
      const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
      await writeFile(repo, 'roles.yaml', ROLES_WITHOUT_OWNER);
      await writeFile(repo, 'access.md', '---\nwrite:\n  - Admin\n---\n');
      return stubWorkspaceService(workspaceId, workspaceDir);
    }

    it('may write roles.yaml even when roles.yaml does not list them', async () => {
      const ws = await seeded();
      const svc = new AccessControlService(ws, PROCESS_MAP_DIR, [OWNER]);
      expect(await svc.canWrite(workspaceId, OWNER, 'roles.yaml')).toBe(true);
    });

    it('may write an access.md — the same rescue the Admin role gets', async () => {
      const ws = await seeded();
      const svc = new AccessControlService(ws, PROCESS_MAP_DIR, [OWNER]);
      expect(await svc.canWrite(workspaceId, OWNER, 'Knowledge/access.md')).toBe(true);
    });

    /**
     * The rescue is exactly two files wide. It is not a general grant: the
     * owner is admitted to the hardcoded `write` overrides and to nothing
     * else, so ordinary content still answers to the access tree.
     */
    it('gets no ordinary write from being the owner', async () => {
      const ws = await seeded();
      const svc = new AccessControlService(ws, PROCESS_MAP_DIR, [OWNER]);
      expect(await svc.canWrite(workspaceId, OWNER, 'Knowledge/Foo.md')).toBe(false);
    });

    it('is matched case-insensitively, like every other email here', async () => {
      const ws = await seeded();
      const svc = new AccessControlService(ws, PROCESS_MAP_DIR, ['OWNER@Bevel.Software']);
      expect(await svc.canWrite(workspaceId, OWNER, 'roles.yaml')).toBe(true);
    });

    /**
     * Unconfigured, nothing changes — which is what keeps every other test in
     * this file (and every fixture that constructs the service with two
     * arguments) meaningful.
     */
    it('changes nothing when no owner is configured', async () => {
      const ws = await seeded();
      const svc = new AccessControlService(ws, PROCESS_MAP_DIR);
      expect(await svc.canWrite(workspaceId, OWNER, 'roles.yaml')).toBe(false);
      expect(await svc.canWrite(workspaceId, 'someone-else@example.com', 'roles.yaml')).toBe(true);
    });
  });
});
