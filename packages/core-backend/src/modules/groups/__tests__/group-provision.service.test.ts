import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_BRANCH, personalGroupFolderName } from '@bevel-software/platform-shared';
import type { AuthUser } from '@bevel-software/platform-shared';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import type { IAccessControl } from '../../access/access-control.interface.js';
import {
  GroupProvisionError,
  GroupProvisionService,
  groupAccessMd,
  personalAccessMd,
} from '../group-provision.service.js';

const KB = 'knowledge-base';
const USER: AuthUser = { id: 'u1-abcd', email: 'ali@example.com', name: 'Ali Vega' } as AuthUser;

/**
 * The service is exercised against a REAL temp directory (the existence
 * check and the rollback are filesystem semantics, not mockable branches),
 * with the workspace, commit and access dependencies stubbed at their seams.
 */
async function makeHarness() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-provision-'));
  const writeFile = vi.fn(
    async (_id: string, rel: string, content: string, opts?: { failIfExists?: boolean }) => {
      const abs = path.join(dir, rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      try {
        await fs.writeFile(abs, content, { encoding: 'utf-8', flag: opts?.failIfExists ? 'wx' : 'w' });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
          const conflict: Error & { status?: number } = new Error(`"${rel}" already exists.`);
          conflict.status = 409;
          throw conflict;
        }
        throw err;
      }
    },
  );
  const workspaceService = {
    getOrCreateForBranch: vi.fn(async () => ({ id: 'ws-main' })),
    getWorkspacePath: vi.fn(async () => dir),
    writeFile,
  } as unknown as WorkspaceService;
  const commits = { runPendingCommit: vi.fn(async () => undefined) };
  const accessControl = { invalidate: vi.fn() } as unknown as IAccessControl;
  const events = { emit: vi.fn() };
  const svc = new GroupProvisionService(workspaceService, commits, accessControl, KB, events);
  return { svc, dir, commits, accessControl, events, writeFile };
}

describe('GroupProvisionService.createGroup', () => {
  let h: Awaited<ReturnType<typeof makeHarness>>;
  beforeEach(async () => {
    h = await makeHarness();
  });

  it('writes the discoverable template, commits it inline, and drops the access cache', async () => {
    const result = await h.svc.createGroup(USER, 'GTM');
    expect(result).toEqual({ folder: 'GTM', created: true });

    const accessMd = await fs.readFile(path.join(h.dir, KB, 'Groups/GTM/access.md'), 'utf-8');
    // Discoverable FILE (frontmatter read: everyone), creator-run FOLDER
    // (body names the creator under all three verbs).
    expect(accessMd.startsWith('---\nread:\n  - everyone\n---\n')).toBe(true);
    const body = accessMd.slice(accessMd.indexOf('---\n', 4) + 4);
    for (const verb of ['read', 'write', 'owner']) {
      expect(body).toMatch(new RegExp(`${verb}:[\\s\\S]*Ali Vega <ali@example.com>`));
    }

    // The commit ran INLINE — the gate reads at HEAD, so an async commit
    // would 403 the creator's very next write into the folder.
    expect(h.commits.runPendingCommit).toHaveBeenCalledWith(
      'ws-main',
      DEFAULT_BRANCH,
      `${KB}/Groups/GTM/access.md`,
      USER,
    );
    expect(h.accessControl.invalidate).toHaveBeenCalledWith('ws-main');
  });

  it('refuses a taken name case-insensitively with 409', async () => {
    await h.svc.createGroup(USER, 'GTM');
    await expect(h.svc.createGroup(USER, 'gtm')).rejects.toMatchObject({ status: 409 });
  });

  it('refuses names the filesystem or the model cannot carry with 422', async () => {
    for (const bad of ['', '  ', 'a/b', 'a\\b', '.', '..', '.hidden', 'personal-anything']) {
      await expect(h.svc.createGroup(USER, bad)).rejects.toBeInstanceOf(GroupProvisionError);
      await expect(h.svc.createGroup(USER, bad)).rejects.toMatchObject({ status: 422 });
    }
    // Nothing landed on disk for any of them.
    await expect(fs.readdir(path.join(h.dir, KB, 'Groups'))).rejects.toThrow();
  });

  it('rolls the seeded file back when the commit fails, so a retry is not told "already exists"', async () => {
    h.commits.runPendingCommit.mockRejectedValueOnce(new Error('push refused'));
    await expect(h.svc.createGroup(USER, 'GTM')).rejects.toThrow('push refused');
    // The folder is gone again — the next attempt starts clean.
    await expect(fs.stat(path.join(h.dir, KB, 'Groups/GTM'))).rejects.toThrow();
    await expect(h.svc.createGroup(USER, 'GTM')).resolves.toEqual({ folder: 'GTM', created: true });
  });
});

describe('GroupProvisionService.ensurePersonalGroup', () => {
  it('creates the private personal folder once, then reports it as existing', async () => {
    const h = await makeHarness();
    const folder = personalGroupFolderName(USER.id);

    const first = await h.svc.ensurePersonalGroup(USER);
    expect(first).toEqual({ folder, created: true });
    const accessMd = await fs.readFile(
      path.join(h.dir, KB, 'Groups', folder, 'access.md'),
      'utf-8',
    );
    // PRIVATE: no `everyone` self-grant anywhere — the file follows the
    // folder chain, and the rules close that chain to the owner alone.
    expect(accessMd).not.toContain('everyone');
    for (const verb of ['read', 'write', 'owner']) {
      expect(accessMd).toMatch(new RegExp(`${verb}:[\\s\\S]*Ali Vega <ali@example.com>`));
    }

    const second = await h.svc.ensurePersonalGroup(USER);
    expect(second).toEqual({ folder, created: false });
    // Idempotent for real: one write, one commit.
    expect(h.writeFile).toHaveBeenCalledTimes(1);
    expect(h.commits.runPendingCommit).toHaveBeenCalledTimes(1);
  });
});

describe('access.md templates', () => {
  it('group template is discoverable, personal template is not — same creator grants in both', () => {
    const group = groupAccessMd(USER);
    const personal = personalAccessMd(USER);
    expect(group).toContain('everyone');
    expect(personal).not.toContain('everyone');
    for (const text of [group, personal]) {
      expect(text).toContain('Ali Vega <ali@example.com>');
    }
  });
});
