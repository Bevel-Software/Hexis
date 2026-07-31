import type { FileDiffPayload, ReviewSession } from '@bevel-software/shared';

/**
 * Shape of the diff service. Backups live in a sibling root that mirrors the
 * workspaces layout: each user/repo has `<backupsRoot>/<userId>/<repoName>/...`
 * holding the "last user-confirmed state" of every diffable file. Drift between
 * disk and backup is the pending-change set.
 *
 * Triggers that update the backup:
 *   - First-time mount (lazy via `currentSession`) seeds from disk.
 *   - User write/delete/rename through WorkspaceService → `syncFromDisk` /
 *     `markUserDeleted`.
 *   - User accept/reject of pending changes.
 *
 * Under the per-branch workspace model each branch has its own clone +
 * its own backup folder, both seeded at bootstrap, so the legacy
 * "branch switch wipes + reseeds the backup" trigger is gone. `resetBackup`
 * + `resetBackupUnlocked` are still on the interface as primitives but
 * have **no production callers** today — kept for potential future
 * mutex-holding use cases.
 *
 * Agent edits, agent shell commits, and `git pull/merge/fetch/commit/push`
 * leave the backup alone — the resulting drift is what the user reviews.
 */
export interface IDiffService {
  /** Wipe the backup folder and reseed from the current working tree. */
  resetBackup(workspaceId: string): Promise<void>;

  /**
   * Same as `resetBackup` but assumes the caller is already holding the
   * workspace mutex (via `WorkspaceMutex.run`). Originally the post-switch
   * backup-reseed hook for `GitService.switchBranch`; that caller is gone
   * with the per-branch workspace model (each branch has its own workspace
   * + its own backup, seeded at bootstrap), so this currently has no
   * production callers — kept in the interface as a primitive for future
   * mutex-holding callers that need a backup reset.
   */
  resetBackupUnlocked(workspaceId: string): Promise<void>;

  /** Pending changes for the current branch, or null when none. */
  currentSession(workspaceId: string): Promise<ReviewSession | null>;

  /** Diff payload (baseline + current) for one path. */
  fileDiff(workspaceId: string, relativePath: string): Promise<FileDiffPayload>;

  /** Promote disk → backup for `relativePath`. Handles file or directory. */
  syncFromDisk(workspaceId: string, relativePath: string): Promise<void>;

  /** Drop backup entry for `relativePath` (file or dir, recursive). */
  markUserDeleted(workspaceId: string, relativePath: string): Promise<void>;

  /** Accept one pending path: backup ← disk (or drop backup if disk-gone). */
  acceptOne(workspaceId: string, relativePath: string): Promise<ReviewSession | null>;

  /** Reject one pending path: disk ← backup (or rm disk if backup-gone). */
  rejectOne(workspaceId: string, relativePath: string): Promise<ReviewSession | null>;

  /**
   * Compute the batch revert plan for `paths` WITHOUT mutating anything: each
   * diffable path resolves to either a write of its pre-agent baseline bytes
   * (backup exists) or a delete (agent-added file, no backup). Also returns
   * the workspace dir so the caller can run the plan through a
   * `LockingFilesystem.writeFiles` batch — one lock sweep, one commit + push.
   * Non-diffable paths are skipped.
   */
  revertPlan(
    workspaceId: string,
    paths: string[],
  ): Promise<{ workspaceDir: string; writes: { path: string; content: Buffer }[]; deletes: string[] }>;

  /**
   * Accept every pending path in ONE batch (single mutex hold, single
   * pending-list walk). `paths` optionally restricts the batch to an
   * allow-list — the accept route passes the caller's readable paths so
   * restricted nodes stay pending.
   */
  acceptAll(workspaceId: string, paths?: string[]): Promise<void>;
}
