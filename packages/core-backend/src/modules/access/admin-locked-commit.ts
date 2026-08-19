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
 *     Release is commit-on-release: `fn` restores its own bytes on failure,
 *     so anything dirty at release time is either clean (queued commit
 *     no-ops) or someone else's still-queued work that must be preserved.
 *     The ONE exception: a path whose restore itself failed
 *     (`unrestoredPaths` on the thrown error) holds known-partial bytes, and
 *     committing those is worse than discarding to HEAD.
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
import { PushNeedsAgentResolutionError, WorkflowDomainError } from '../workflow/workflow.errors.js';
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
  constructor(private readonly deps: LockedCommitDeps) {}

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
      unrestored = (err as { unrestoredPaths?: Set<string> } | null)?.unrestoredPaths ?? null;
      throw err;
    } finally {
      for (const h of held) {
        try {
          if (unrestored?.has(h)) {
            await this.deps.workflowService.releaseLockNoCommit(workspaceId, this.defaultBranch, h, actor);
          } else {
            await this.deps.workflowService.releaseLock(workspaceId, this.defaultBranch, h, actor);
          }
        } catch { /* best-effort release */ }
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
