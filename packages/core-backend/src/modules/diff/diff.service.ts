import fs from 'node:fs/promises';
import path from 'node:path';
import type { FileDiffPayload, PendingChange, ReviewSession, ChangeKind } from '@bevel-software/platform-shared';
import type { IDiffService } from './diff.interface.js';
import type { WorkspaceService } from '../workspace/workspace.service.js';
import type { WorkspaceMutex } from '../kb-fs/mutex.js';
import { BevelIgnoreStack } from '../workspace/bevel-ignore.js';
import { isDiffable } from './diff.config.js';
import { assertWithinDirectory } from './diff-paths.js';
import { countLineChanges } from './line-diff.js';

/**
 * On-disk backup ledger. Owns `<backupsRoot>/<userId>/<repoName>/...` and
 * exposes pending-change / accept / reject ops over it. See `diff.interface.ts`
 * for trigger semantics.
 */
export class DiffService implements IDiffService {
  constructor(
    private readonly workspaceService: WorkspaceService,
    private readonly mutex: WorkspaceMutex,
    private readonly workspacesRoot: string,
    private readonly backupsRoot: string,
    private readonly kbDirName: string,
  ) {}

  // ── public API ──────────────────────────────────────────────────────────

  async resetBackup(workspaceId: string): Promise<void> {
    return this.mutex.run(workspaceId, () => this.reseedUnlocked(workspaceId));
  }

  async resetBackupUnlocked(workspaceId: string): Promise<void> {
    return this.reseedUnlocked(workspaceId);
  }

  async currentSession(workspaceId: string): Promise<ReviewSession | null> {
    return this.mutex.run(workspaceId, () => this.sessionUnlocked(workspaceId));
  }

  async fileDiff(workspaceId: string, relativePath: string): Promise<FileDiffPayload> {
    return this.mutex.run(workspaceId, async () => {
      // Seed the backup ledger if this is the first call on a fresh workspace
      // — otherwise every untouched file would surface as `kind: 'added'`
      // because the backup side is empty.
      await this.ensureSeededUnlocked(workspaceId);
      const { fileAbs, backupAbs } = await this.resolvePair(workspaceId, relativePath);
      const [diskBuf, backupBuf] = await Promise.all([
        fs.readFile(fileAbs).catch(() => null),
        fs.readFile(backupAbs).catch(() => null),
      ]);
      if (diskBuf === null && backupBuf === null) {
        // Path doesn't exist on either side — the caller asked for a diff of
        // a path that was never tracked. Fail fast instead of returning a
        // garbage `modified` payload with both sides null.
        throw new Error(`Path not in pending changes: ${relativePath}`);
      }
      const isBinary =
        (diskBuf !== null && looksBinary(diskBuf)) ||
        (backupBuf !== null && looksBinary(backupBuf));
      const kind: ChangeKind =
        backupBuf === null ? 'added' : diskBuf === null ? 'deleted' : 'modified';
      return {
        path: relativePath,
        kind,
        baseline: backupBuf && !isBinary ? backupBuf.toString('utf-8') : null,
        current: diskBuf && !isBinary ? diskBuf.toString('utf-8') : null,
        isBinary,
      };
    });
  }

  async syncFromDisk(workspaceId: string, relativePath: string): Promise<void> {
    return this.mutex.run(workspaceId, async () => {
      const { fileAbs, backupAbs, workspaceDir, backupDir } = await this.resolvePair(
        workspaceId,
        relativePath,
      );
      let stat;
      try {
        stat = await fs.stat(fileAbs);
      } catch {
        // Disk-gone — nothing to sync; let `markUserDeleted` handle removals explicitly.
        return;
      }
      if (stat.isDirectory()) {
        await fs.mkdir(backupAbs, { recursive: true });
        await this.copyDiffableTree(workspaceDir, backupDir, fileAbs);
      } else if (stat.isFile() && isDiffable(relativePath)) {
        await fs.mkdir(path.dirname(backupAbs), { recursive: true });
        await atomicCopy(fileAbs, backupAbs);
      }
    });
  }

  async markUserDeleted(workspaceId: string, relativePath: string): Promise<void> {
    return this.mutex.run(workspaceId, async () => {
      const { backupAbs } = await this.resolvePair(workspaceId, relativePath);
      await fs.rm(backupAbs, { recursive: true, force: true });
    });
  }

  async acceptOne(workspaceId: string, relativePath: string): Promise<ReviewSession | null> {
    return this.mutex.run(workspaceId, async () => {
      // Seed the backup baseline before mutating so single-file accept on a
      // never-listed workspace doesn't leave a partial backup folder that
      // would phantom every other untouched .md as `added` on the next list.
      // Mirrors the seed `acceptAll` gets via `listPendingUnlocked`.
      await this.ensureSeededUnlocked(workspaceId);
      await this.acceptOneUnlocked(workspaceId, relativePath);
      return this.sessionUnlocked(workspaceId);
    });
  }

  async rejectOne(workspaceId: string, relativePath: string): Promise<ReviewSession | null> {
    return this.mutex.run(workspaceId, async () => {
      // Same seeding rationale as `acceptOne` — without this, a reject on a
      // fresh workspace would partial-create the backup folder, then ghost-add
      // every other unedited .md.
      await this.ensureSeededUnlocked(workspaceId);
      await this.rejectOneUnlocked(workspaceId, relativePath);
      return this.sessionUnlocked(workspaceId);
    });
  }

  async acceptAll(workspaceId: string, paths?: string[]): Promise<void> {
    return this.mutex.run(workspaceId, async () => {
      const changes = await this.listPendingUnlocked(workspaceId);
      // Optional allow-list (the route passes the caller's READABLE paths so
      // restricted nodes stay pending). One mutex hold + ONE pending-list walk
      // for the whole batch — accepting N of M workspace files is O(M + N).
      // Looping the public `acceptOne` per path instead re-walks and re-diffs
      // the entire workspace after every single accept (O(N×M)), which on a
      // large agent change-set pins the accept request for minutes.
      const allow = paths ? new Set(paths) : null;
      for (const c of changes) {
        if (allow && !allow.has(c.path)) continue;
        await this.acceptOneUnlocked(workspaceId, c.path);
      }
    });
  }

  async revertPlan(
    workspaceId: string,
    paths: string[],
  ): Promise<{ workspaceDir: string; writes: { path: string; content: Buffer }[]; deletes: string[] }> {
    return this.mutex.run(workspaceId, async () => {
      await this.ensureSeededUnlocked(workspaceId);
      const workspaceDir = await this.workspaceService.getWorkspacePath(workspaceId);
      const writes: { path: string; content: Buffer }[] = [];
      const deletes: string[] = [];
      for (const rel of paths) {
        if (!isDiffable(rel)) continue;
        const { backupAbs } = await this.resolvePair(workspaceId, rel);
        try {
          // Backup exists → the revert is a write of the pre-agent baseline
          // bytes (Buffer: pending changes can be binary).
          writes.push({ path: rel, content: await fs.readFile(backupAbs) });
        } catch (err) {
          // ONLY a missing backup means "agent-added file → the revert
          // discards it". Any other read failure (EACCES, EMFILE, …) must
          // abort the plan — misclassifying it as no-backup would DELETE a
          // file whose baseline we merely failed to read.
          const code = (err as NodeJS.ErrnoException | null)?.code;
          if (code !== 'ENOENT') throw err;
          deletes.push(rel);
        }
      }
      return { workspaceDir, writes, deletes };
    });
  }

  // ── internals (mutex assumed held) ──────────────────────────────────────

  private async sessionUnlocked(workspaceId: string): Promise<ReviewSession | null> {
    const changes = await this.listPendingUnlocked(workspaceId);
    if (changes.length === 0) return null;
    const branchName = await this.tryReadCurrentBranch(workspaceId);
    return {
      branchName,
      baselineRef: '',
      createdAt: new Date(0).toISOString(),
      changes,
    };
  }

  private async listPendingUnlocked(workspaceId: string): Promise<PendingChange[]> {
    await this.ensureSeededUnlocked(workspaceId);
    const workspaceDir = await this.workspaceService.getWorkspacePath(workspaceId);
    const backupDir = await this.getBackupDir(workspaceId);
    const candidates = new Set<string>();
    await walkDiffable(workspaceDir, workspaceDir, candidates);
    await walkAll(backupDir, backupDir, candidates);
    const pending: PendingChange[] = [];
    for (const rel of candidates) {
      const change = await computePending(workspaceDir, backupDir, rel);
      if (change) pending.push(change);
    }
    pending.sort((a, b) => a.path.localeCompare(b.path));
    return pending;
  }

  private async ensureSeededUnlocked(workspaceId: string): Promise<void> {
    const backupDir = await this.getBackupDir(workspaceId);
    try {
      await fs.access(backupDir);
      return;
    } catch {
      // missing → seed
    }
    const workspaceDir = await this.workspaceService.getWorkspacePath(workspaceId);
    // **Stage into a tmp dir, then rename.** If `copyDiffableTree` throws
    // mid-stream (out-of-space, a transient EACCES on one file, etc.) we
    // must NOT leave a half-populated `backupDir` behind: future calls
    // would see `fs.access(backupDir)` succeed and skip the seed entirely,
    // then `listPendingUnlocked` would report every cloned file as a
    // phantom `added` change (workspace has it, backup doesn't). The
    // rename is the atomic commit — either the fully-seeded backup
    // appears at its final path, or nothing does and the next call
    // retries from scratch.
    //
    // Also protects against two concurrent processes (clustered Node
    // worker) racing — only one rename wins; the loser sees backupDir
    // present on its next access check and bails.
    await fs.mkdir(path.dirname(backupDir), { recursive: true });
    const stagingDir = `${backupDir}.seed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      await fs.mkdir(stagingDir, { recursive: true });
      await this.copyDiffableTree(workspaceDir, stagingDir, workspaceDir);
      try {
        await fs.rename(stagingDir, backupDir);
      } catch (renameErr) {
        // EEXIST / ENOTEMPTY: a concurrent seeder won the race. Their
        // backupDir is the canonical one — drop our staging and move on.
        const code = (renameErr as NodeJS.ErrnoException | null)?.code;
        if (code === 'EEXIST' || code === 'ENOTEMPTY') {
          await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
          return;
        }
        throw renameErr;
      }
    } catch (err) {
      await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
      throw err;
    }
  }

  private async reseedUnlocked(workspaceId: string): Promise<void> {
    const workspaceDir = await this.workspaceService.getWorkspacePath(workspaceId);
    const backupDir = await this.getBackupDir(workspaceId);
    // Same atomic-replace pattern as `ensureSeededUnlocked`: stage into
    // a tmp dir, then swap with the existing backup. A failure mid-copy
    // leaves the previous backup intact instead of vaporising it; a
    // success swaps the new tree in cleanly.
    await fs.mkdir(path.dirname(backupDir), { recursive: true });
    const stagingDir = `${backupDir}.reseed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const oldBackupTrash = `${backupDir}.trash-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      await fs.mkdir(stagingDir, { recursive: true });
      await this.copyDiffableTree(workspaceDir, stagingDir, workspaceDir);
      // Move-aside-then-rename: rename only works if the destination is
      // missing OR empty (Linux). We swap via a trash path to keep this
      // atomic-ish even when the old backup is populated.
      try {
        await fs.rename(backupDir, oldBackupTrash);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException | null)?.code;
        if (code !== 'ENOENT') throw err; // no existing backup is fine
      }
      await fs.rename(stagingDir, backupDir);
      await fs.rm(oldBackupTrash, { recursive: true, force: true }).catch(() => undefined);
    } catch (err) {
      await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
      // If we already moved the old backup aside but the second rename
      // failed, restore it so the next caller sees the previous state.
      try {
        await fs.access(oldBackupTrash);
        try { await fs.rename(oldBackupTrash, backupDir); } catch { /* leave for cleanup sweep */ }
      } catch {
        /* old backup was never moved aside */
      }
      throw err;
    }
  }

  private async acceptOneUnlocked(workspaceId: string, relativePath: string): Promise<void> {
    if (!isDiffable(relativePath)) return;
    const { fileAbs, backupAbs } = await this.resolvePair(workspaceId, relativePath);
    let diskExists = true;
    try {
      await fs.access(fileAbs);
    } catch {
      diskExists = false;
    }
    if (diskExists) {
      await fs.mkdir(path.dirname(backupAbs), { recursive: true });
      await atomicCopy(fileAbs, backupAbs);
    } else {
      // Confirmed delete — drop the backup so the path no longer surfaces as pending.
      await fs.rm(backupAbs, { force: true });
    }
  }

  private async rejectOneUnlocked(workspaceId: string, relativePath: string): Promise<void> {
    if (!isDiffable(relativePath)) return;
    const { fileAbs, backupAbs } = await this.resolvePair(workspaceId, relativePath);
    let backupExists = true;
    try {
      await fs.access(backupAbs);
    } catch {
      backupExists = false;
    }
    if (backupExists) {
      await fs.mkdir(path.dirname(fileAbs), { recursive: true });
      await fs.copyFile(backupAbs, fileAbs);
    } else {
      // No backup — agent-added file. Reject discards it.
      await fs.rm(fileAbs, { force: true });
    }
  }

  // ── path + walk helpers ─────────────────────────────────────────────────

  private async getBackupDir(workspaceId: string): Promise<string> {
    const workspaceDir = await this.workspaceService.getWorkspacePath(workspaceId);
    const rel = path.relative(this.workspacesRoot, workspaceDir);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error('Workspace lives outside workspacesRoot');
    }
    return path.join(this.backupsRoot, rel);
  }

  private async resolvePair(
    workspaceId: string,
    relativePath: string,
  ): Promise<{ workspaceDir: string; backupDir: string; fileAbs: string; backupAbs: string }> {
    const workspaceDir = await this.workspaceService.getWorkspacePath(workspaceId);
    const backupDir = await this.getBackupDir(workspaceId);
    const fileAbs = path.resolve(workspaceDir, relativePath);
    const backupAbs = path.resolve(backupDir, relativePath);
    assertWithinDirectory(fileAbs, workspaceDir);
    assertWithinDirectory(backupAbs, backupDir);
    return { workspaceDir, backupDir, fileAbs, backupAbs };
  }

  private async copyDiffableTree(
    workspaceDir: string,
    backupDir: string,
    currentDir: string,
    parentIgnore: BevelIgnoreStack = BevelIgnoreStack.empty(),
  ): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    const ignoreStack = await parentIgnore.extendedWith(currentDir);
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === '.workspace.json') continue;
      const srcPath = path.join(currentDir, entry.name);
      if (ignoreStack.isIgnored(srcPath, entry.isDirectory())) continue;
      const rel = path.relative(workspaceDir, srcPath);
      const dstPath = path.join(backupDir, rel);
      if (entry.isDirectory()) {
        await this.copyDiffableTree(workspaceDir, backupDir, srcPath, ignoreStack);
      } else if (entry.isFile() && isDiffable(entry.name)) {
        await fs.mkdir(path.dirname(dstPath), { recursive: true });
        await fs.copyFile(srcPath, dstPath);
      }
    }
  }

  /**
   * Read the current branch name from `<repo>/.git/HEAD` without going through
   * GitService (which would create a circular dep). Returns '' if HEAD points
   * at a detached commit or anything else we can't parse — the field is
   * cosmetic on the response and the frontend tolerates an empty string.
   */
  private async tryReadCurrentBranch(workspaceId: string): Promise<string> {
    const workspaceDir = await this.workspaceService.getWorkspacePath(workspaceId);
    try {
      const head = await fs.readFile(
        path.join(workspaceDir, this.kbDirName, '.git', 'HEAD'),
        'utf-8',
      );
      const m = head.match(/^ref:\s+refs\/heads\/(.+?)\s*$/);
      return m ? m[1] : '';
    } catch {
      return '';
    }
  }
}

// ── module-private helpers ────────────────────────────────────────────────

async function atomicCopy(src: string, dst: string): Promise<void> {
  const tmp = dst + '.tmp';
  try {
    await fs.copyFile(src, tmp);
    await fs.rename(tmp, dst);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

function looksBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(buf.length, 8192));
  return sample.indexOf(0) !== -1;
}

async function walkDiffable(
  root: string,
  dir: string,
  out: Set<string>,
  parentIgnore: BevelIgnoreStack = BevelIgnoreStack.empty(),
): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const ignoreStack = await parentIgnore.extendedWith(dir);
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === '.workspace.json') continue;
    const abs = path.join(dir, entry.name);
    if (ignoreStack.isIgnored(abs, entry.isDirectory())) continue;
    if (entry.isDirectory()) {
      await walkDiffable(root, abs, out, ignoreStack);
    } else if (entry.isFile() && isDiffable(entry.name)) {
      out.add(path.relative(root, abs).replace(/\\/g, '/'));
    }
  }
}

async function walkAll(root: string, dir: string, out: Set<string>): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkAll(root, abs, out);
    } else if (entry.isFile()) {
      // Strip the .tmp suffix from in-flight atomic writes so a crashed write
      // doesn't surface as a phantom "modified" entry on the next list call.
      if (entry.name.endsWith('.tmp')) continue;
      out.add(path.relative(root, abs).replace(/\\/g, '/'));
    }
  }
}

async function computePending(
  workspaceDir: string,
  backupDir: string,
  relativePath: string,
): Promise<PendingChange | null> {
  if (!isDiffable(relativePath)) return null;
  const fileAbs = path.resolve(workspaceDir, relativePath);
  const backupAbs = path.resolve(backupDir, relativePath);
  const [diskBuf, backupBuf] = await Promise.all([
    fs.readFile(fileAbs).catch(() => null),
    fs.readFile(backupAbs).catch(() => null),
  ]);
  if (diskBuf === null && backupBuf === null) return null;
  if (diskBuf !== null && backupBuf !== null && diskBuf.equals(backupBuf)) return null;

  // Either side being binary is enough to disable text decoding + LCS — keeps
  // `computePending` and `fileDiff` agreeing on the binary classification, and
  // avoids decoding a binary buffer as utf-8 just because the other side
  // happens to be text.
  const isBinary =
    (diskBuf !== null && looksBinary(diskBuf)) ||
    (backupBuf !== null && looksBinary(backupBuf));

  let kind: ChangeKind;
  let linesAdded: number | null = null;
  let linesRemoved: number | null = null;

  if (backupBuf === null) {
    kind = 'added';
    if (!isBinary) {
      const counts = countLineChanges('', diskBuf!.toString('utf-8'));
      linesAdded = counts.added;
      linesRemoved = counts.removed;
    }
  } else if (diskBuf === null) {
    kind = 'deleted';
    if (!isBinary) {
      const counts = countLineChanges(backupBuf.toString('utf-8'), '');
      linesAdded = counts.added;
      linesRemoved = counts.removed;
    }
  } else {
    kind = 'modified';
    if (!isBinary) {
      const counts = countLineChanges(backupBuf.toString('utf-8'), diskBuf.toString('utf-8'));
      linesAdded = counts.added;
      linesRemoved = counts.removed;
    }
  }

  return { path: relativePath, kind, isBinary, linesAdded, linesRemoved };
}
