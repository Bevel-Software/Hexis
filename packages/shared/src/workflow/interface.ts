/**
 * `IWorkflowService` — the abstraction the rest of the app talks to instead
 * of raw git/gh. See `bevel-platform/PLAN.md` for the motivation and the spec the
 * methods here encode (protected branches, atomic per-file changes, file
 * locks, change requests as branch-pair reconciliations).
 *
 * Naming convention: methods speak workflow vocabulary (`commitChange`,
 * `openChangeRequest`, `acquireLock`), never git vocabulary (`commit`,
 * `createPr`, no analogue for locks). Implementations may delegate to the
 * existing git/PR/review-workflow services until those are folded into
 * `modules/workflow`; callers should not depend on that fact.
 *
 * Some methods on this interface have no backing service yet — file locks,
 * `openChangeRequest`, `updateFromTarget`. The facade implementation throws
 * `NotImplementedWorkflowError` from those until the underlying support
 * lands. The interface defines them up-front so consumers can plan against
 * the final surface area.
 */

import type { AuthUser } from '../auth/types.js';
import type {
  AcquireLockResult,
  Branch,
  BranchWorkspaceStatus,
  CancelChangeRequestResult,
  Change,
  ChangeInput,
  ChangeRequest,
  ChangeRequestComment,
  ChangeRequestDetail,
  ChangeRequestState,
  ChangedFile,
  FileApproval,
  FileLock,
  MergeChangeRequestOutcome,
  OpenChangeRequestInput,
  PostChangeRequestCommentInput,
} from './types.js';

export interface IWorkflowService {
  // ── Branches ──────────────────────────────────────────────────────────────

  listBranches(workspaceId: string, opts?: { freshFetch?: boolean }): Promise<Branch[]>;
  /**
   * Create a new unprotected branch. Protected branches cannot be created
   * via the workflow — the protected set is bootstrapped from the KB repo's
   * initial state and never grown at runtime.
   */
  createBranch(workspaceId: string, name: string, fromBase?: string): Promise<Branch>;
  /**
   * Delete a branch. Removes both local and origin refs in one call. The
   * branch's author (per `<email-localpart>/...` naming) OR an admin (per the
   * workspace's `roles.yaml`) can delete it. Admins can additionally remove
   * unprefixed CLI-created branches that have no recognisable author.
   *
   * `onlyIfNoRemote: true` is the legacy orphan-cleanup path: bypasses the
   * author/admin check (callers prune any orphan they encounter) and refuses
   * if origin still has the ref. Protected and current branches always reject.
   */
  deleteBranch(
    workspaceId: string,
    name: string,
    user: AuthUser,
    opts?: { onlyIfNoRemote?: boolean },
  ): Promise<void>;
  // `switchBranch` removed: under the per-branch workspace model the active
  // branch is the workspace's identity. Switching branches is a workspace
  // selection (`WorkspaceService.getOrCreateForBranch`), not an operation
  // on an existing workspace's clone.
  // `forkCurrentToDraft` removed: under the per-branch workspace model each
  // branch is its own workspace; nothing carries uncommitted edits across.
  // `createBranch` + URL navigation covers the "start a new draft" intent.
  /** Current branch's workspace status — currently just the branch name + upstream sync state. */
  branchStatus(workspaceId: string): Promise<BranchWorkspaceStatus>;
  // `discardWorkingChanges` removed: under save=share the working tree is
  // never dirty, so there is nothing for "undo my unsaved edits" to undo.
  /**
   * Push the current branch upstream so other users (and change requests)
   * can see the commits on it. Workflow term: "share current branch". The
   * underlying implementation is `git push -u origin <branch>`.
   */
  shareCurrentBranch(workspaceId: string, user: AuthUser): Promise<void>;
  /**
   * Number of commits on `branch` that aren't on `baseBranch` — exactly
   * what a CR from `branch` to `baseBranch` would propose for review.
   * Implemented as `git rev-list --count <baseBranch>..<branch>` against
   * the workspace's clone; returns 0 when the branch has no unmerged
   * commits (a fresh fork that nobody wrote to) and when either ref
   * cannot be resolved. Background runs use this to decide whether a
   * routine branch deserves a change request — without it, a run where
   * the agent commits files but forgets to call `open_change_request`
   * would silently lose its work to the no-changes cleanup path.
   */
  countCommitsAhead(workspaceId: string, branch: string, baseBranch: string): Promise<number>;
  /** Fetch remote refs without modifying the working tree. */
  refreshRemotes(workspaceId: string): Promise<void>;
  /**
   * Pull the latest remote state into the current branch (rebase strategy).
   * On a rebase CONFLICT (local commits vs origin), throws the typed
   * pull-conflict error AND queues a background recovery run attributed to
   * `user` when provided (falls back to the recovery bot).
   */
  updateFromRemote(workspaceId: string, user?: AuthUser): Promise<void>;
  /**
   * Hard-reset the workspace's checked-out branch to `origin/<branch>` (fetch
   * first), discarding any local divergence. Break-glass primitive for
   * roles.yaml recovery so the restoring commit can fast-forward on push.
   */
  resetToRemote(workspaceId: string, branch: string): Promise<void>;
  /**
   * Best-fit protected branch that `branch` was forked from — picks the
   * protected branch on origin yielding the smallest "ahead" count.
   * Returns null if no protected branch can be reached.
   */
  resolveForkBase(workspaceId: string, branch: string): Promise<string | null>;
  /**
   * Paths that the next `commitChange` would include — what `git add -A`
   * would stage: modified + deleted + renamed + untracked (honouring
   * `.gitignore`). Returns only paths.
   */
  listPendingChangePaths(workspaceId: string): Promise<string[]>;
  // `listWorkingChanges` + `diffFileInWorking` removed: under save=share the
  // working tree is never dirty, so both report the empty state by
  // definition. Cross-branch / per-commit diff cases are covered by
  // `compareFile` + `showFileAtChange` below.

  // ── Changes ───────────────────────────────────────────────────────────────

  /**
   * Commit one atomic change. The current backing implementation packs every
   * dirty path in the working tree into the commit; the workflow spec
   * eventually constrains this to one file per change, enforced at the
   * commit boundary. Until that lands, callers should already commit
   * one-file-at-a-time by convention.
   */
  commitChange(workspaceId: string, user: AuthUser, input: ChangeInput): Promise<Change>;
  /**
   * Commit whatever the caller has already written to the working tree as ONE
   * atomic change, then push. Unlike `commitChange` (one file at a time, guarded
   * at the commit boundary) this commits the whole dirty set together — for the
   * rare case where a group of files must land together or not at all (e.g. a
   * role rename rewriting `roles.yaml` + every reference). Does NOT write
   * content: the caller writes the files first (e.g. via the lock-aware
   * filesystem) and is responsible for any validation. Returns null on a
   * no-op — nothing to commit WITHIN SCOPE: with `onlyPaths` given, none of
   * those paths is dirty (other paths may well be); without it, the whole
   * tree is clean.
   *
   * `onlyPaths` (workspace-relative) scopes the commit to the caller's own
   * files: on a shared per-branch workspace other paths may be dirty from a
   * concurrent save whose commit is still queued, and an unscoped commit
   * would sweep them in under this caller's author/summary. Omitted → the
   * whole dirty set (legacy behavior for flows that own the workspace).
   */
  commitChanges(
    workspaceId: string,
    user: AuthUser,
    summary: string,
    onlyPaths?: string[],
  ): Promise<Change | null>;
  /** Per-file history. Newest first; clamps to ≤ 100 entries. */
  listChangesForFile(workspaceId: string, path: string, limit?: number): Promise<Change[]>;
  /**
   * Diff of one file between two branches. Both names must resolve to a
   * known branch on this workspace (local head or remote-tracking). Returns
   * the raw unified diff body — empty when identical, includes the
   * "new file" / "deleted file" headers when the file only exists on one
   * side.
   */
  compareFile(
    workspaceId: string,
    path: string,
    fromBranch: string,
    toBranch: string,
  ): Promise<string>;
  /**
   * Diff of one file at a specific change (sha) — i.e. `git show <sha> -- <path>`.
   * Used by the File viewer's History tab.
   */
  showFileAtChange(workspaceId: string, path: string, sha: string): Promise<string>;
  /**
   * Full file contents on both sides of one change: `baseline` at `<sha>^`
   * (null when the file — or the parent commit — doesn't exist there),
   * `current` at `<sha>` (null when absent). Used by the File viewer's
   * History tab to render markdown changes as a rendered-markdown diff.
   */
  fileAtChange(
    workspaceId: string,
    path: string,
    sha: string,
  ): Promise<{ baseline: string | null; current: string | null }>;

  // ── File locks (new — currently NotImplementedWorkflowError) ──────────────

  /**
   * Try to acquire an edit lock on `(branch, path)` for the caller. Returns
   * `{ acquired: true, lock }` on success; `{ acquired: false, lock }` if
   * someone else already holds it (the existing lock is included so the UI
   * can render "Locked by X" without a follow-up call).
   *
   * Pessimistic per the spec. Auto-released when the lock expires past TTL
   * without a heartbeat — stale locks must not block forever.
   *
   * `opts.coordination` acquires the lock as a PURE MUTEX: the implementation
   * skips its write-permission gate for the path, because the caller only
   * wants to serialize against the path's writer (e.g. hold a machine-owned
   * file steady across a read → check → decide flow) and will never write the
   * path itself. A coordination hold grants NO write authority — the mode is
   * persisted on the lock row, and every path that would treat "you hold the
   * lock" as write possession (`commitFileWhileLocked`, `releaseLock`'s
   * commit enqueue) refuses a coordination hold. Contention, TTL, and
   * heartbeat behave identically. Release ONLY via `releaseLockNoCommit` (or
   * `releaseLockUntouched`) — `releaseLock` rejects rather than ever enqueue
   * a commit for a hold that was never allowed to write. Internal callers
   * only; never plumbed from a route.
   */
  acquireLock(
    workspaceId: string,
    branch: string,
    path: string,
    user: AuthUser,
    opts?: { coordination?: boolean },
  ): Promise<AcquireLockResult>;
  /** Heartbeat to keep an acquired lock alive past its current TTL. */
  heartbeatLock(workspaceId: string, branch: string, path: string, user: AuthUser): Promise<FileLock>;
  /**
   * Commit the lock-held file's accumulated edits as a change *without*
   * releasing the lock. Used by the client-side autosave checkpoint timer
   * so the lock stays exclusively the caller's across many interim
   * commits — releasing + reacquiring around every checkpoint would let
   * another user grab the lock in the gap. Returns `null` when the file
   * has no pending edits (idempotent). Refused when the lock isn't held
   * by `user`.
   */
  commitFileWhileLocked(
    workspaceId: string,
    branch: string,
    path: string,
    user: AuthUser,
    summary?: string,
  ): Promise<Change | null>;

  /**
   * Release a held lock. The "I'm done editing this file" terminal signal.
   *
   * **Does not commit or push synchronously.** This method enqueues a row in
   * `pending_commits` and drops the lock, then returns `void`. The background
   * `PendingCommitsWorker` claims the row, synthesises the commit subject
   * (callers do *not* supply one — the worker derives a default from the path
   * and any worker-side metadata), runs `commitFile` against whatever bytes
   * are on disk, and pushes the result. Decoupling the user-visible lock
   * release from git means a transient push failure no longer wedges the
   * editor, and a process crash mid-commit becomes resumable instead of
   * leaving an orphan on disk. See `lock-decoupling-plan.md` for the full
   * design.
   *
   * The autosave-checkpoint timer and explicit `commitChange` calls land
   * commits directly (no queue); `releaseLock` is queue-only.
   */
  releaseLock(
    workspaceId: string,
    branch: string,
    path: string,
    user: AuthUser,
  ): Promise<void>;
  /**
   * Drop the lock **without committing**. Used on the failure path of a
   * lock-aware write — when the underlying op threw, we don't want the
   * normal `releaseLock` to commit + push whatever partial state happens
   * to be on disk. The lock row goes away (so the next caller can edit
   * the file) and the path's working-tree changes are discarded back to
   * HEAD on a BEST-EFFORT basis: the implementation logs and continues
   * when the discard itself fails (releasing beats stranding the lock),
   * so a caller must not treat a completed release as proof the tree is
   * clean — worst case the path stays dirty until the next save on it.
   * Idempotent like `releaseLock`: a no-op when the caller doesn't hold
   * the lock.
   */
  releaseLockNoCommit(
    workspaceId: string,
    branch: string,
    path: string,
    user: AuthUser,
  ): Promise<void>;
  /**
   * Drop the lock for a path the caller held but **never touched** — the
   * third release shape, between `releaseLock` and `releaseLockNoCommit`.
   * Neither enqueues a commit (on a shared workspace the path may carry a
   * PRIOR save's dirty bytes whose queued commit an enqueue would re-attribute
   * to this caller and whose retry ladder it would reset) nor discards (a
   * discard back to HEAD would destroy those same still-queued bytes). Used
   * by batch flows for paths that were merely locked — a creator seed that
   * no-op'd, a path never reached before the batch failed. Idempotent like
   * the other releases: a no-op when the caller doesn't hold the lock.
   */
  releaseLockUntouched(
    workspaceId: string,
    branch: string,
    path: string,
    user: AuthUser,
  ): Promise<void>;
  /**
   * Whether the background commit queue holds a LIVE row (one the worker
   * will still drive — pending or running, not a terminally-escalated one)
   * for `(branch, path)`. Lets a caller that landed a commit but hit a push
   * failure PROVE the retry vehicle exists instead of inferring it from
   * lock state (a release that failed before its enqueue and a release that
   * enqueued-then-dropped both leave the lock gone — only the queue itself
   * can tell them apart).
   */
  hasQueuedCommit(workspaceId: string, branch: string, path: string): Promise<boolean>;
  /**
   * Whether the workspace's local branch is ahead of (or has no) upstream —
   * i.e. holds commits not yet published. The complement of `hasQueuedCommit`
   * for push-retry proofs: no live queued row AND nothing unpushed means the
   * worker already drained the row and published it.
   */
  hasUnpushedCommits(workspaceId: string): Promise<boolean>;
  /** Current lock holder for `(branch, path)`, or null when nobody holds it. */
  getLock(workspaceId: string, branch: string, path: string): Promise<FileLock | null>;

  // ── Change Requests ───────────────────────────────────────────────────────

  listChangeRequests(opts?: { fresh?: boolean }): Promise<ChangeRequest[]>;
  /** Change requests authored by the given user (matched on stored author identity). */
  listChangeRequestsAuthoredBy(
    emailOrLogin: string,
    opts?: { fresh?: boolean },
  ): Promise<ChangeRequest[]>;
  /** Change requests touching files the user has write permission on. */
  listChangeRequestsForUser(
    workspaceId: string,
    email: string,
    opts?: { fresh?: boolean },
  ): Promise<ChangeRequest[]>;
  getChangeRequest(number: number): Promise<ChangeRequest | null>;
  getChangeRequestDetail(
    number: number,
    /**
     * `fresh` bypasses the detail cache. `patches` defaults to true: clients
     * get the full detail, per-file patches included, and it is cached.
     * `patches: false` is for internal reads that never look at
     * `files[].patch` (approve / withdraw / revert pin their work on the
     * detail): patch generation is skipped and the result stays out of the
     * detail cache. Mirrors IPullRequestService.getPrDetail.
     */
    opts?: { fresh?: boolean; workspaceId?: string; viewerEmail?: string; patches?: boolean },
  ): Promise<ChangeRequestDetail | null>;

  /**
   * Open a new change request. Per spec, auto-merges `targetBranch` into
   * `sourceBranch` and surfaces the resulting diff as the changes to review.
   * Throws `NotImplementedWorkflowError` until the backing create-PR path
   * lands in the workflow module (today the agent shells `gh pr create`
   * directly).
   */
  openChangeRequest(
    workspaceId: string,
    user: AuthUser,
    input: OpenChangeRequestInput,
  ): Promise<ChangeRequestDetail>;

  /**
   * Re-run `targetBranch → sourceBranch` merge on an existing change request.
   * Used when the target has advanced since the change request was opened.
   * Throws `NotImplementedWorkflowError` until the backing merge path lands.
   */
  updateFromTarget(workspaceId: string, user: AuthUser, number: number): Promise<ChangeRequestDetail>;

  // Comments
  listComments(number: number): Promise<ChangeRequestComment[]>;
  postComment(
    number: number,
    user: AuthUser,
    input: PostChangeRequestCommentInput,
    headSha: string,
  ): Promise<ChangeRequestComment>;
  editComment(commentId: string, number: number, user: AuthUser, body: string): Promise<ChangeRequestComment>;
  deleteComment(commentId: string, number: number, user: AuthUser): Promise<void>;

  // Approvals — per-file, tied to the file's current change. New changes
  // invalidate approvals on the affected file.
  approveFile(
    number: number,
    path: string,
    user: AuthUser,
    files: ChangedFile[],
    headSha: string,
    baseBranch: string,
    authorIdHash: string | null,
    workspaceId: string,
  ): Promise<FileApproval[]>;
  unapproveFile(
    number: number,
    path: string,
    user: AuthUser,
    files: ChangedFile[],
    headSha: string,
    baseBranch: string,
    authorIdHash: string | null,
    workspaceId: string,
  ): Promise<FileApproval[]>;

  /**
   * Decline ONE file of an open change request: restore its merge-base
   * version on the source branch so it drops out of the request's diff.
   * Same permission as approving the file. When the last file is declined
   * the request closes itself and its source branch is retired
   * (`closed: true` in the result).
   */
  revertChangeRequestFile(
    number: number,
    user: AuthUser,
    repoRelPath: string,
  ): Promise<{ closed: boolean; remainingPaths: string[] }>;

  /**
   * Close an OPEN change request whose diff has emptied (authoritatively
   * re-verified; a failed diff never closes) and retire its source branch.
   * Returns true when this call closed it.
   */
  closeEmptyChangeRequest(number: number, user: AuthUser): Promise<boolean>;

  /**
   * Close every open change request whose source branch no longer exists.
   * Such a request cannot be read, reviewed, applied or declined — it is a
   * tombstone, and it makes every open-list poll throw `unknown branch`.
   *
   * Closes rather than deletes (the row is the only surviving evidence of the
   * proposal), and fails safe: an unreachable origin closes nothing, because
   * "cannot reach" and "was deleted" look identical from here. Returns how
   * many it closed. No `user` — it is a system sweep, not somebody's verdict.
   */
  closeChangeRequestsWithDeletedBranches(): Promise<number>;

  /**
   * Delete a change request outright: close it and retire its source branch.
   * Admin-only (write on `roles.yaml` at `origin/<base>`); refuses a merged
   * request.
   */
  deleteChangeRequest(number: number, user: AuthUser): Promise<void>;

  /**
   * Reject a change request without merging. Authorized for the author or
   * for users with write permission to every changed file on the target
   * branch.
   */
  rejectChangeRequest(
    number: number,
    user: AuthUser,
    state: ChangeRequestState,
    authorIdHash: string | null,
    baseBranch: string,
    workspaceId: string,
  ): Promise<CancelChangeRequestResult>;

  /**
   * Merge a change request. The workflow tries a direct merge first; on
   * conflicts it returns a `conflicts-need-resolution` outcome and the
   * caller (typically the agent) is responsible for resolving them as new
   * changes on the source branch. Once the source contains target cleanly,
   * a subsequent `mergeChangeRequest` call lands the merge.
   *
   * The hard merge invariant — only this method may invoke `gh pr merge` —
   * is preserved through the facade by delegating to
   * `IReviewWorkflowService.mergePr`.
   */
  mergeChangeRequest(
    number: number,
    user: AuthUser,
    headSha: string,
    approvals: FileApproval[],
    state: ChangeRequestState,
    title: string,
    baseBranch: string,
    workspaceId: string,
    opts?: { bypass?: boolean },
  ): Promise<MergeChangeRequestOutcome>;
}
