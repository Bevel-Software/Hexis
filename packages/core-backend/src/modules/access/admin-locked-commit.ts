/**
 * SHARED transactional lock/commit helper for the admin roster services
 * (roles + groups). The two services used to carry twin copies of this
 * machinery, which diverged once into a real bug — this is the single
 * implementation both delegate to, parameterized only by the domain-error
 * constructor, log tag, and contention wording.
 *
 * The shape of every roster write:
 *
 *   withFileLocks(paths, fn)          — acquire every path's lock (sorted,
 *     all-or-nothing; strict even for the same user), run `fn`, release.
 *     HOW each lock is released depends on the outcome (see the finally
 *     block for the full reasoning):
 *       - `fn` succeeded → releaseLockNoCommit for every path the batch
 *         commit LANDED on (tracked by writeAndCommitLocked): the commit
 *         landed AND pushed, so the tree there is clean (the discard
 *         no-ops); releaseLock would instead ENQUEUE a commit before
 *         dropping the row, and an enqueue failure then strands the lock
 *         until TTL. A held path the batch never committed keeps
 *         commit-on-release — it may carry a PRIOR holder's still-queued
 *         work, which a discard would destroy.
 *       - `fn` threw PushNeedsAgentResolutionError → releaseLock. The commit
 *         landed but the push didn't; the enqueued release commit IS the
 *         retry (the worker sees the clean tree, notices unpushed commits,
 *         and re-runs the cooperative push ladder).
 *       - `fn` threw anything else → releaseLock (commit-on-release): `fn`
 *         restored its own bytes, so anything dirty at release time is
 *         either clean (queued commit no-ops) or someone else's still-queued
 *         work that must be preserved. The ONE exception: a path whose
 *         restore itself failed (`unrestoredPaths` on the thrown error)
 *         holds known-partial bytes → releaseLockNoCommit discards to HEAD.
 *     Every release is per-path best-effort: one failed release logs and
 *     moves on so it can never strand the REST of the held locks.
 *
 *   writeAndCommitLocked(files)       — the write half of a withFileLocks
 *     flow: plain-write each file (the lock is already ours — strict
 *     same-user acquire forbids LockingFilesystem here) and commit them as
 *     ONE path-scoped change. On a PRE-commit failure, best-effort restore of
 *     each file's original bytes (`original: null` = the file did not exist,
 *     so restoration DELETES it). A POST-commit failure — the push after a
 *     landed commit (`PushNeedsAgentResolutionError`, thrown with the commit
 *     intact) — must NOT restore: the edit is committed locally and restoring
 *     would publish a compensating revert of a landed change. It propagates
 *     as-is ("saved locally … will be resolved"), locks release normally, and
 *     the pending-commit ladder retries the share.
 */

import path from 'node:path';

import { LockingFilesystem } from '../workflow/locking-filesystem.js';
import { PushNeedsAgentResolutionError, WorkflowDomainError } from '../../shared/domain-errors.js';
import type { AuthUser, IWorkspaceService, IWorkflowService } from '@bevel-software/platform-shared';
import type { FileContent } from '@mastra/core/workspace';

export interface LockedCommitDeps {
  workspaceService: IWorkspaceService;
  workflowService: IWorkflowService;
  kbDirName: string;
  /** Live-binding thunk — DEFAULT_BRANCH stays empty until setup. */
  defaultBranchOf: () => string;
  /** Domain-error constructor (RolesAdminError / GroupsAdminError). */
  makeError: (message: string, status: number, payload?: Record<string, unknown>) => WorkflowDomainError;
  /** Log prefix, e.g. 'roles-admin' / 'groups-admin'. */
  logTag: string;
  /** Contention wording: what is "being edited by <holder>". */
  contendedSubject: string;
  /** Pre-disk write validator handed to LockingFilesystem writes. */
  validateWrite?: (path: string, content: FileContent) => void;
}

export interface LockedWrite {
  repoRel: string;
  content: string;
  /** null = the file did not exist before (restore DELETES it). */
  original: string | null;
}

export class AdminLockedCommits {
  /**
   * Workspace-scoped ws-relative paths whose bytes a `writeAndCommitLocked`
   * batch has committed (and pushed) while their locks are held — i.e. paths
   * whose working tree is KNOWN clean. `withFileLocks` releases exactly these
   * with `releaseLockNoCommit` on success (see the module doc) and clears
   * each entry as it releases. Keyed `<workspaceId>\0<wsRelPath>` so two
   * workspaces can't cross-talk.
   */
  private readonly committedCleanPaths = new Set<string>();

  constructor(private readonly deps: LockedCommitDeps) {}

  private cleanKey(workspaceId: string, wsRelPath: string): string {
    return `${workspaceId}\0${wsRelPath}`;
  }

  private get defaultBranch(): string {
    return this.deps.defaultBranchOf();
  }

  wsRel(repoRel: string): string {
    return `${this.deps.kbDirName}/${repoRel}`;
  }

  async repoDir(workspaceId: string): Promise<string> {
    const wsDir = await this.deps.workspaceService.getWorkspacePath(workspaceId);
    return path.join(wsDir, this.deps.kbDirName);
  }

  /** Read a KB-root file; null when genuinely absent. */
  async readKbFile(workspaceId: string, repoRel: string): Promise<string | null> {
    try {
      return await this.deps.workspaceService.readFile(
        workspaceId,
        path.posix.join(this.deps.kbDirName, repoRel),
      );
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | null)?.code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return null;
      throw err;
    }
  }

  /**
   * A lock-aware filesystem scoped to `actor` — writes auto-commit + push as
   * the actor on release, through the same pipeline as the human editor and
   * agent. Built per-op because the lock context captures the acting user.
   * Only for flows that do NOT already hold the file locks (acquire is strict
   * even same-user); a withFileLocks flow writes via writeAndCommitLocked.
   */
  async lockingFsForActor(workspaceId: string, actor: AuthUser): Promise<LockingFilesystem> {
    const basePath = await this.deps.workspaceService.getWorkspacePath(workspaceId);
    return new LockingFilesystem(
      { basePath, contained: true },
      {
        workflow: this.deps.workflowService,
        workspaceId,
        branch: this.defaultBranch,
        user: actor,
        validateWrite: this.deps.validateWrite,
      },
    );
  }

  /**
   * Map LockingFilesystem's status-less contention error ("Skipped editing …
   * — locked by …") to the friendly 409. Callers pre-check the common case,
   * but that is a TOCTOU check — this catches the race so contention always
   * surfaces as a 409, never an unhandled 500.
   */
  async mapLockContention<T>(write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } catch (err) {
      if (err instanceof Error && /locked by /.test(err.message)) {
        throw this.deps.makeError(
          `${this.deps.contendedSubject} are being edited by another admin. Try again in a moment.`,
          409,
        );
      }
      throw err;
    }
  }

  /**
   * Run `fn` while HOLDING the named KB-file locks (sorted, all-or-nothing):
   * read-modify-write flows must keep the lock across the READ too, or two
   * concurrent edits (another tab, another admin, a conversion) both snapshot
   * the same base and the second write silently discards the first. See the
   * module doc for the release semantics.
   */
  async withFileLocks<T>(
    workspaceId: string,
    actor: AuthUser,
    repoRelFiles: string[],
    fn: () => Promise<T>,
  ): Promise<T> {
    const paths = repoRelFiles.map((f) => this.wsRel(f)).sort();
    const held: string[] = [];
    let failure: unknown | null = null;
    let unrestored: Set<string> | null = null;
    try {
      for (const p of paths) {
        const res = await this.deps.workflowService.acquireLock(workspaceId, this.defaultBranch, p, actor);
        if (!res.acquired) {
          throw this.deps.makeError(
            `${this.deps.contendedSubject} are being edited by ${res.lock.holderName || 'another admin'}. Try again in a moment.`,
            409,
          );
        }
        held.push(p);
      }
      return await fn();
    } catch (err) {
      failure = err;
      unrestored = (err as { unrestoredPaths?: Set<string> } | null)?.unrestoredPaths ?? null;
      throw err;
    } finally {
      // Outcome-dependent release — see the module doc. The key hazard this
      // guards: `releaseLock` ENQUEUES the release commit BEFORE dropping the
      // lock row (deliberately, so a crash can't orphan bytes), which means an
      // enqueue failure leaves the row held until TTL. After a SUCCESSFUL
      // batch commit there is nothing left to commit — writeAndCommitLocked
      // committed and pushed these exact paths, and we hold their locks, so
      // the tree there is clean — so releaseLockNoCommit (whose discard
      // no-ops on a clean path) releases without ever touching the queue.
      //
      // EXCEPT on the push-retry path: PushNeedsAgentResolutionError means
      // the commit landed but the push didn't, and the enqueued release
      // commit is what retries the push (runPendingCommit: clean tree +
      // unpushed commits → pushWithRecovery). That path MUST releaseLock.
      // Failures there log + continue so one bad enqueue strands at most its
      // own lock (TTL backstop), never the rest.
      const pushRetry = failure instanceof PushNeedsAgentResolutionError;
      for (const h of held) {
        const committedClean =
          this.committedCleanPaths.delete(this.cleanKey(workspaceId, h)) && !pushRetry;
        try {
          if (committedClean || unrestored?.has(h)) {
            // Batch-committed path (clean tree — discard no-ops) — even when
            // `fn` threw AFTER the commit+push landed: the failure says
            // nothing about the tree, and releaseLock would enqueue a
            // pointless commit whose enqueue failure strands a known-clean
            // lock until TTL. Or known-partial bytes (restore failed —
            // discarding to HEAD beats committing them).
            await this.deps.workflowService.releaseLockNoCommit(workspaceId, this.defaultBranch, h, actor);
          } else {
            // Push-retry (the enqueued commit retries the share), the
            // restored-failure path, and any held path the batch never
            // committed (commit-on-release: a prior holder's still-queued
            // work must be preserved, never discarded).
            await this.deps.workflowService.releaseLock(workspaceId, this.defaultBranch, h, actor);
          }
        } catch (releaseErr) {
          console.warn(
            `[${this.deps.logTag}] could not release lock on ${h}${pushRetry ? ' (push-retry release)' : ''}; ` +
              'it frees on TTL — continuing with the remaining locks:',
            releaseErr instanceof Error ? releaseErr.message : releaseErr,
          );
        }
      }
    }
  }

  /**
   * Plain-write `files` and commit them as ONE path-scoped change — the write
   * half of a `withFileLocks` flow. See the module doc for the pre- vs
   * post-commit failure split; only PRE-commit failures restore.
   */
  async writeAndCommitLocked(
    workspaceId: string,
    actor: AuthUser,
    files: LockedWrite[],
    summary: string,
  ): Promise<void> {
    const { workspaceService, workflowService, logTag } = this.deps;
    try {
      for (const f of files) await workspaceService.writeFile(workspaceId, this.wsRel(f.repoRel), f.content);
      await workflowService.commitChanges(workspaceId, actor, summary, files.map((f) => this.wsRel(f.repoRel)));
      // Commit landed AND pushed — the tree at these paths is clean. Mark
      // them so withFileLocks releases them WITHOUT enqueueing a release
      // commit (see the module doc — an enqueue failure would strand the
      // lock until TTL for a commit there is nothing left to make).
      for (const f of files) this.committedCleanPaths.add(this.cleanKey(workspaceId, this.wsRel(f.repoRel)));
    } catch (err) {
      // POST-commit failure: the commit landed and only the PUSH needs help
      // (thrown "with the commit intact"). The bytes on disk match the landed
      // commit — restoring pre-edit bytes here would publish a compensating
      // revert of a change that exists. No restore; release proceeds
      // normally; the error itself tells the caller "saved locally, sharing
      // will be resolved" and the pending-commit ladder retries the push.
      if (err instanceof PushNeedsAgentResolutionError) {
        console.warn(
          `[${logTag}] commit landed but the push needs resolution — edit saved; publishing will be retried`,
        );
        throw err;
      }
      const unrestored = new Set<string>();
      for (const f of files) {
        try {
          if (f.original === null) await workspaceService.deleteFile(workspaceId, this.wsRel(f.repoRel));
          else await workspaceService.writeFile(workspaceId, this.wsRel(f.repoRel), f.original);
        } catch (restoreErr) {
          // Deleting an already-absent file IS the original state.
          if (f.original === null && (restoreErr as NodeJS.ErrnoException | null)?.code === 'ENOENT') continue;
          unrestored.add(this.wsRel(f.repoRel));
          console.warn(`[${logTag}] could not restore ${f.repoRel} after a failed commit`);
        }
      }
      if (unrestored.size > 0 && typeof err === 'object' && err !== null) {
        (err as { unrestoredPaths?: Set<string> }).unrestoredPaths = unrestored;
      }
      throw err;
    }
  }
}
