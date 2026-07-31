import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { WorkspaceService, workspaceIdForBranch } from '../../workspace/workspace.service.js';
import { WorkspaceMutex } from '../../workflow/git/mutex.js';
import { DiffService } from '../diff.service.js';

async function mkTmpRoot(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

// Workspace-per-branch (PLAN §3) — the test fixture uses a fake branch
// `diff-test-branch`. The workspace id is `encodeURIComponent(branch)`
// and the on-disk path is `<workspacesRoot>/<id>/<kbDirName>/`. We
// pre-seed the inner `.git` so `WorkspaceService.resolveWorkspaceDir`
// accepts the path without falling back to the clone-from-origin
// bootstrap that the unit suite can't perform.
const TEST_BRANCH = 'diff-test-branch';

interface Fixture {
  workspacesRoot: string;
  backupsRoot: string;
  workspaceDir: string;
  repoDir: string;
  workspaceId: string;
  workspaceService: WorkspaceService;
  diffService: DiffService;
}

async function setup(): Promise<Fixture> {
  const workspacesRoot = await mkTmpRoot('bevel-diff-ws-');
  const backupsRoot = await mkTmpRoot('bevel-diff-backup-');
  const workspaceId = workspaceIdForBranch(TEST_BRANCH);
  const workspaceDir = path.join(workspacesRoot, workspaceId);
  const repoDir = path.join(workspaceDir, 'knowledge-base');
  // Inner `.git` dir is the marker `resolveWorkspaceDir` looks for.
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

describe('DiffService', () => {
  let fx: Fixture;
  beforeEach(async () => { fx = await setup(); });
  afterEach(async () => { await teardown(fx); });

  it('seeds the backup folder lazily on first session read and reports no drift on a clean tree', async () => {
    await fs.writeFile(path.join(fx.repoDir, 'foo.md'), '# Hello\n', 'utf-8');
    const session = await fx.diffService.currentSession(fx.workspaceId);
    // Nothing pending — disk == backup after seed.
    expect(session).toBeNull();
    // Backup file was written.
    const backupPath = path.join(fx.backupsRoot, fx.workspaceId, 'knowledge-base', 'foo.md');
    expect(await fs.readFile(backupPath, 'utf-8')).toBe('# Hello\n');
  });

  it('surfaces an agent-created untracked file as added (the juju.md regression)', async () => {
    // First session call seeds with no diffable files.
    await fx.diffService.currentSession(fx.workspaceId);
    // Agent writes a new file directly to disk (bypassing WorkspaceService).
    await fs.writeFile(path.join(fx.repoDir, 'juju.md'), '# new\n', 'utf-8');
    const session = await fx.diffService.currentSession(fx.workspaceId);
    expect(session?.changes.length).toBe(1);
    expect(session!.changes[0]).toMatchObject({
      path: 'knowledge-base/juju.md',
      kind: 'added',
      isBinary: false,
    });
  });

  it('user-saved edit through WorkspaceService advances the backup so it does NOT show as pending', async () => {
    await fs.writeFile(path.join(fx.repoDir, 'foo.md'), 'before\n', 'utf-8');
    await fx.diffService.currentSession(fx.workspaceId); // seed
    // User edit goes through WorkspaceService → triggers diffService.syncFromDisk.
    await fx.workspaceService.writeFile(fx.workspaceId, 'knowledge-base/foo.md', 'after\n');
    const session = await fx.diffService.currentSession(fx.workspaceId);
    expect(session).toBeNull(); // backup advanced; no drift
  });

  it('detects a modified file (agent edit on top of seeded backup)', async () => {
    await fs.writeFile(path.join(fx.repoDir, 'foo.md'), 'before\n', 'utf-8');
    await fx.diffService.currentSession(fx.workspaceId); // seed
    // Agent edits via shell — disk only.
    await fs.writeFile(path.join(fx.repoDir, 'foo.md'), 'after\n', 'utf-8');
    const session = await fx.diffService.currentSession(fx.workspaceId);
    expect(session?.changes[0]).toMatchObject({
      path: 'knowledge-base/foo.md',
      kind: 'modified',
      linesAdded: 1,
      linesRemoved: 1,
    });
  });

  it('acceptOne promotes disk → backup so the next session is clean', async () => {
    await fs.writeFile(path.join(fx.repoDir, 'foo.md'), 'v1\n', 'utf-8');
    await fx.diffService.currentSession(fx.workspaceId);
    await fs.writeFile(path.join(fx.repoDir, 'foo.md'), 'v2\n', 'utf-8');
    expect((await fx.diffService.currentSession(fx.workspaceId))?.changes.length).toBe(1);
    await fx.diffService.acceptOne(fx.workspaceId, 'knowledge-base/foo.md');
    expect(await fx.diffService.currentSession(fx.workspaceId)).toBeNull();
  });

  it('acceptAll with an allow-list accepts only those paths in ONE batch; the rest stay pending', async () => {
    // The accept route passes the caller's READABLE paths — a restricted node
    // must stay pending. One service call covers the whole batch (looping
    // acceptOne per path re-walks the workspace per file, O(changes × files)).
    await fs.writeFile(path.join(fx.repoDir, 'a.md'), 'v1\n', 'utf-8');
    await fs.writeFile(path.join(fx.repoDir, 'b.md'), 'v1\n', 'utf-8');
    await fx.diffService.currentSession(fx.workspaceId); // seed
    await fs.writeFile(path.join(fx.repoDir, 'a.md'), 'v2\n', 'utf-8');
    await fs.writeFile(path.join(fx.repoDir, 'b.md'), 'v2\n', 'utf-8');
    expect((await fx.diffService.currentSession(fx.workspaceId))?.changes.length).toBe(2);
    await fx.diffService.acceptAll(fx.workspaceId, ['knowledge-base/a.md']);
    const session = await fx.diffService.currentSession(fx.workspaceId);
    expect(session?.changes.map((c) => c.path)).toEqual(['knowledge-base/b.md']);
  });

  it('acceptAll without an allow-list accepts everything', async () => {
    await fs.writeFile(path.join(fx.repoDir, 'a.md'), 'v1\n', 'utf-8');
    await fx.diffService.currentSession(fx.workspaceId); // seed
    await fs.writeFile(path.join(fx.repoDir, 'a.md'), 'v2\n', 'utf-8');
    await fx.diffService.acceptAll(fx.workspaceId);
    expect(await fx.diffService.currentSession(fx.workspaceId)).toBeNull();
  });

  it('rejectOne restores disk ← backup', async () => {
    await fs.writeFile(path.join(fx.repoDir, 'foo.md'), 'v1\n', 'utf-8');
    await fx.diffService.currentSession(fx.workspaceId);
    await fs.writeFile(path.join(fx.repoDir, 'foo.md'), 'v2\n', 'utf-8');
    await fx.diffService.rejectOne(fx.workspaceId, 'knowledge-base/foo.md');
    expect(await fs.readFile(path.join(fx.repoDir, 'foo.md'), 'utf-8')).toBe('v1\n');
  });

  it('rejectOne on an agent-created file removes it from disk', async () => {
    await fx.diffService.currentSession(fx.workspaceId); // seed (empty)
    await fs.writeFile(path.join(fx.repoDir, 'created.md'), 'agent\n', 'utf-8');
    await fx.diffService.rejectOne(fx.workspaceId, 'knowledge-base/created.md');
    await expect(fs.access(path.join(fx.repoDir, 'created.md'))).rejects.toThrow();
  });

  it('non-diffable extensions never enter the pending list', async () => {
    await fs.writeFile(path.join(fx.repoDir, 'image.png'), Buffer.from([0xff, 0xd8, 0xff]));
    await fx.diffService.currentSession(fx.workspaceId);
    // Agent writes another binary.
    await fs.writeFile(path.join(fx.repoDir, 'other.png'), Buffer.from([0x89, 0x50, 0x4e]));
    expect(await fx.diffService.currentSession(fx.workspaceId)).toBeNull();
  });

  it('resetBackup wipes + reseeds (branch-switch hook): pending agent change disappears', async () => {
    await fs.writeFile(path.join(fx.repoDir, 'foo.md'), 'v1\n', 'utf-8');
    await fx.diffService.currentSession(fx.workspaceId);
    await fs.writeFile(path.join(fx.repoDir, 'foo.md'), 'v2\n', 'utf-8');
    expect((await fx.diffService.currentSession(fx.workspaceId))?.changes.length).toBe(1);
    await fx.diffService.resetBackup(fx.workspaceId);
    expect(await fx.diffService.currentSession(fx.workspaceId)).toBeNull();
  });

  it('rejects path-traversal attempts (must use a diffable extension to even reach the path check)', async () => {
    await fs.writeFile(path.join(fx.repoDir, 'foo.md'), 'x', 'utf-8');
    await fx.diffService.currentSession(fx.workspaceId);
    await expect(
      fx.diffService.acceptOne(fx.workspaceId, '../../../etc/passwd.md'),
    ).rejects.toThrow(/Path traversal/);
  });

  it('reports kind=deleted when the user deletes a file via WorkspaceService — backup drops, no phantom', async () => {
    await fs.writeFile(path.join(fx.repoDir, 'foo.md'), 'x', 'utf-8');
    await fx.diffService.currentSession(fx.workspaceId); // seeds backup with foo.md
    await fx.workspaceService.deleteFile(fx.workspaceId, 'knowledge-base/foo.md');
    expect(await fx.diffService.currentSession(fx.workspaceId)).toBeNull();
  });

  it('agent-deleted file (disk-rm without WorkspaceService) shows as kind=deleted', async () => {
    await fs.writeFile(path.join(fx.repoDir, 'foo.md'), 'x\n', 'utf-8');
    await fx.diffService.currentSession(fx.workspaceId); // seed
    await fs.rm(path.join(fx.repoDir, 'foo.md'));
    const session = await fx.diffService.currentSession(fx.workspaceId);
    expect(session?.changes[0]).toMatchObject({
      path: 'knowledge-base/foo.md',
      kind: 'deleted',
    });
  });
});
