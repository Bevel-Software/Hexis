import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { WorkspaceService, workspaceIdForBranch } from '../../workspace/workspace.service.js';
import { WorkspaceMutex } from '../../workflow/git/mutex.js';
import { DiffService } from '../diff.service.js';

/**
 * Atomic-seed regression suite.
 *
 * Bug we're guarding against (reproduced once in production): two users
 * switch to a fresh, not-yet-cloned branch concurrently. One of them sees
 * EVERY cloned file as an `added` pending change.
 *
 * Root cause: the original `ensureSeededUnlocked` did `mkdir(backupDir)`
 * THEN `copyDiffableTree(...)`. If the copy threw mid-stream (any I/O
 * hiccup, EACCES on one file, the process restarted, …) `backupDir`
 * already existed but was empty. The next call's `fs.access(backupDir)`
 * succeeded → skipped seeding → `listPendingUnlocked` saw "workspace has
 * files, backup is empty" and produced phantom `added` entries for every
 * cloned file.
 *
 * Fix: stage into `<backupDir>.seed-<rand>`, then `fs.rename` to commit.
 * Either the fully-seeded backup appears at its canonical path, or
 * nothing does and the next caller retries from scratch. Same pattern
 * applies to `reseedUnlocked` (branch-switch hook).
 */

const TEST_BRANCH = 'seed-test-branch';

interface Fixture {
  workspacesRoot: string;
  backupsRoot: string;
  workspaceDir: string;
  repoDir: string;
  workspaceId: string;
  workspaceService: WorkspaceService;
  diffService: DiffService;
}

async function mkTmpRoot(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function setup(): Promise<Fixture> {
  const workspacesRoot = await mkTmpRoot('bevel-seed-ws-');
  const backupsRoot = await mkTmpRoot('bevel-seed-backup-');
  const workspaceId = workspaceIdForBranch(TEST_BRANCH);
  const workspaceDir = path.join(workspacesRoot, workspaceId);
  const repoDir = path.join(workspaceDir, 'knowledge-base');
  await fs.mkdir(path.join(repoDir, '.git'), { recursive: true });
  const workspaceService = new WorkspaceService(
    workspacesRoot,
    'https://github.com/Bevel-Software/knowledge-base.git',
    'knowledge-base',
  );
  const mutex = new WorkspaceMutex();
  const diffService = new DiffService(
    workspaceService,
    mutex,
    workspacesRoot,
    backupsRoot,
    'knowledge-base',
  );
  workspaceService.setDiffService(diffService);
  return { workspacesRoot, backupsRoot, workspaceDir, repoDir, workspaceId, workspaceService, diffService };
}

async function teardown(fx: Fixture): Promise<void> {
  await fs.rm(fx.workspacesRoot, { recursive: true, force: true });
  await fs.rm(fx.backupsRoot, { recursive: true, force: true });
}

async function listDirEntries(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

describe('DiffService — atomic seed (production regression suite)', () => {
  let fx: Fixture;
  beforeEach(async () => { fx = await setup(); });
  afterEach(async () => { await teardown(fx); });

  it('a failed seed leaves NO backupDir behind — the next call retries from scratch', async () => {
    // Stub `fs.copyFile` so the inner copy throws partway through. The
    // seed must then clean up its staging dir AND propagate the error
    // without leaving a phantom backup root. Otherwise the next seed
    // would no-op on the empty backupDir and report every file as
    // `added`.
    await fs.writeFile(path.join(fx.repoDir, 'a.md'), 'a\n', 'utf-8');
    await fs.writeFile(path.join(fx.repoDir, 'b.md'), 'b\n', 'utf-8');

    const copySpy = vi.spyOn(fs, 'copyFile').mockRejectedValueOnce(new Error('disk full'));
    await expect(fx.diffService.currentSession(fx.workspaceId)).rejects.toThrow(/disk full/);
    copySpy.mockRestore();

    // The CANONICAL backupDir must not exist.
    const backupDir = path.join(fx.backupsRoot, fx.workspaceId);
    await expect(fs.access(backupDir)).rejects.toThrow();

    // And no staging dirs left behind (the production symptom of the
    // old bug was the directory shell sitting there empty).
    const siblings = await listDirEntries(fx.backupsRoot);
    expect(siblings).toEqual([]);

    // A follow-up call with the failure cleared seeds cleanly and
    // reports no pending changes.
    const session = await fx.diffService.currentSession(fx.workspaceId);
    expect(session).toBeNull();
    expect(await fs.readFile(path.join(backupDir, 'knowledge-base', 'a.md'), 'utf-8')).toBe('a\n');
  });

  it('two concurrent seeds against the same workspace produce a single backup with no phantom pending', async () => {
    // Mutex-serialised in practice, but we exercise the concurrency
    // anyway so a future refactor that drops the mutex still has to
    // keep the seed atomic. Both callers should observe `session === null`
    // (workspace == backup); neither should see phantom `added` entries.
    await fs.writeFile(path.join(fx.repoDir, 'foo.md'), 'foo\n', 'utf-8');
    await fs.writeFile(path.join(fx.repoDir, 'bar.md'), 'bar\n', 'utf-8');

    const [s1, s2] = await Promise.all([
      fx.diffService.currentSession(fx.workspaceId),
      fx.diffService.currentSession(fx.workspaceId),
    ]);

    expect(s1).toBeNull();
    expect(s2).toBeNull();

    // Backup is fully populated.
    const backupRepo = path.join(fx.backupsRoot, fx.workspaceId, 'knowledge-base');
    expect(await fs.readFile(path.join(backupRepo, 'foo.md'), 'utf-8')).toBe('foo\n');
    expect(await fs.readFile(path.join(backupRepo, 'bar.md'), 'utf-8')).toBe('bar\n');

    // No stray staging dirs.
    const entries = await listDirEntries(fx.backupsRoot);
    expect(entries).toEqual([fx.workspaceId]);
  });

  it('reseed (branch-switch hook) leaves the previous backup intact when the new copy fails', async () => {
    // The branch-switch reseed wipes the existing backup and replaces it
    // with a fresh copy of the new branch's working tree. If the copy
    // fails mid-stream, we must NOT vaporise the old backup — the user
    // would otherwise see every file on the OLD branch flip to pending.
    await fs.writeFile(path.join(fx.repoDir, 'a.md'), 'before\n', 'utf-8');
    // Seed the initial backup.
    await fx.diffService.currentSession(fx.workspaceId);
    const backupFile = path.join(fx.backupsRoot, fx.workspaceId, 'knowledge-base', 'a.md');
    expect(await fs.readFile(backupFile, 'utf-8')).toBe('before\n');

    // Disk advances (e.g. branch checkout swapped the bytes), then reseed.
    await fs.writeFile(path.join(fx.repoDir, 'a.md'), 'after\n', 'utf-8');
    const copySpy = vi.spyOn(fs, 'copyFile').mockRejectedValueOnce(new Error('disk full'));
    await expect(fx.diffService.resetBackup(fx.workspaceId)).rejects.toThrow(/disk full/);
    copySpy.mockRestore();

    // The OLD backup is still there. `listPendingUnlocked` sees `after`
    // on disk vs `before` in backup → one modified entry (correct
    // behavior because the new bytes haven't been promoted yet).
    expect(await fs.readFile(backupFile, 'utf-8')).toBe('before\n');
    const session = await fx.diffService.currentSession(fx.workspaceId);
    expect(session?.changes.length).toBe(1);
    expect(session!.changes[0]).toMatchObject({
      path: 'knowledge-base/a.md',
      kind: 'modified',
    });
  });

  it('reseed succeeds: old backup vaporised, new backup matches new disk state, session is clean', async () => {
    await fs.writeFile(path.join(fx.repoDir, 'a.md'), 'v1\n', 'utf-8');
    await fx.diffService.currentSession(fx.workspaceId);
    // Branch switched (simulated): disk now has different bytes.
    await fs.writeFile(path.join(fx.repoDir, 'a.md'), 'v2\n', 'utf-8');
    await fx.diffService.resetBackup(fx.workspaceId);

    // Backup advanced; session reports no drift.
    const backupFile = path.join(fx.backupsRoot, fx.workspaceId, 'knowledge-base', 'a.md');
    expect(await fs.readFile(backupFile, 'utf-8')).toBe('v2\n');
    expect(await fx.diffService.currentSession(fx.workspaceId)).toBeNull();
  });
});
