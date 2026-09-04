/**
 * Workflow vocabulary — the abstraction our app speaks instead of raw git/gh.
 *
 * Most types here alias existing engineering types in `@bevel-software/platform-shared/git/*` so
 * the workflow layer is a single source of truth without duplicating the
 * payload shapes our backend already produces. The point of the aliases is the
 * *name*: callers depend on `Change` / `ChangeRequest` / `Branch`, never on
 * `Commit` / `PullRequest` / `Branch` from the git module. When we eventually
 * collapse `modules/git` and `modules/review-workflow` into `modules/workflow`,
 * the alias targets move with the implementation; the consumer-facing names
 * don't need to.
 *
 * New types that have no git counterpart (file locks, change-request open
 * inputs, conflict-resolution payloads) live here directly.
 */

import type {
  BranchInfo,
  CommitAttribution,
  ShareChangesRequest,
  WorkingTreeStatus,
} from '../git/types.js';
import type {
  CancelPrResult,
  FileApprovalState,
  MergePrResult,
  PullRequestDetail,
  PullRequestState,
  PullRequestSummary,
  PostPrCommentInput,
  PrReviewComment,
  PullRequestFile,
} from '../git/pr.types.js';

// ── Branches ─────────────────────────────────────────────────────────────────

/** A variation of the ontology. Protected or not. */
export type Branch = BranchInfo;

/**
 * Snapshot of the workspace tied to a branch — currently-checked-out branch,
 * dirty bit, unshared commit count. Mirrors `WorkingTreeStatus` from the git
 * module. Renames to `BranchWorkspaceStatus` in the workflow domain to signal
 * "this describes the branch's workspace state", not raw git plumbing.
 */
export type BranchWorkspaceStatus = WorkingTreeStatus;

// ── Changes ──────────────────────────────────────────────────────────────────

/**
 * A change is the atomic unit of history. Each change affects exactly one file.
 * Creating an empty folder is modeled as a change creating a `.gitkeep` in it.
 * Renames are a single change touching one path with the old path removed in
 * the same atomic operation. Aliases `CommitAttribution` because that's
 * exactly the shape the backend already returns for a single commit.
 */
export type Change = CommitAttribution;

/**
 * Input shape for committing a change. `summary` is required and single-line;
 * `description` is optional and supports a multi-line body. Aliases
 * `ShareChangesRequest` for now — once the workflow module owns the validator
 * gate end-to-end, this shape may grow workflow-specific fields (lock token,
 * forced single-path scope).
 */
export type ChangeInput = ShareChangesRequest;

// ── File locks (new — no git counterpart) ────────────────────────────────────

/**
 * A live edit lock on one (branch, path). Per the workflow spec:
 *   - acquired on first edit in edit mode, or on agent write
 *   - per-(branch, path); the same file on another branch is independently lockable
 *   - autosave checkpoint timer extends the lock and produces intermediate changes
 *   - stale locks (no heartbeat past TTL) auto-release so a disconnected client
 *     can't hold a file hostage
 *
 * Holder identity carries both `userId` (the join key against the users table)
 * and `holderName` (display name, denormalised so consumers can render a
 * "locked by Alice" badge without an extra round-trip). For agent-driven
 * writes the holder is the user driving the agent.
 */
export interface FileLock {
  branch: string;
  path: string;
  holderUserId: string;
  holderName: string;
  /**
   * How the lock was acquired. `'edit'` (the default when absent) is a normal
   * write hold — the holder is editing and the release publishes their bytes.
   * `'coordination'` is a pure-mutex hold (see `IWorkflowService.acquireLock`)
   * that grants NO write authority: the write/checkpoint/commit-enqueue paths
   * must refuse to treat it as write possession, even though its contention,
   * TTL, and heartbeat surface is identical.
   */
  mode?: 'edit' | 'coordination';
  /** ISO timestamp when the lock was first acquired. */
  acquiredAt: string;
  /** ISO timestamp of the most recent heartbeat — the autosave/keepalive ping. */
  lastHeartbeatAt: string;
  /** ISO timestamp after which a non-heartbeated lock is considered stale and may be reclaimed. */
  expiresAt: string;
}

/**
 * Result of attempting to acquire a lock. `acquired: false` carries the
 * current holder so the UI can render "Locked by X" without a follow-up call.
 */
export type AcquireLockResult =
  | { acquired: true; lock: FileLock }
  | { acquired: false; lock: FileLock };

// ── Change Requests ──────────────────────────────────────────────────────────

/**
 * A change request is the reconciliation of two branches. In the current
 * implementation this is backed by a GitHub pull request; the alias hides
 * that from callers. `state` values map 1:1 (`open`/`merged`/`closed`).
 *
 * Opening a change request is defined in the spec as auto-merging target →
 * source first; that part isn't yet implemented in the backing services, so
 * `openChangeRequest` on `IWorkflowService` currently throws
 * `NotImplementedWorkflowError`.
 */
export type ChangeRequest = PullRequestSummary;
export type ChangeRequestDetail = PullRequestDetail;
export type ChangeRequestState = PullRequestState;
export type ChangedFile = PullRequestFile;

export type FileApproval = FileApprovalState;
export type MergeChangeRequestResult = MergePrResult;
export type CancelChangeRequestResult = CancelPrResult;
export type ChangeRequestComment = PrReviewComment;
export type PostChangeRequestCommentInput = PostPrCommentInput;

/**
 * Input for opening a new change request. The workflow auto-merges
 * `targetBranch` into `sourceBranch` as part of opening, so callers don't
 * pass a head SHA — the workflow resolves the head itself.
 *
 * `title` + `description` are the change request's metadata; the description
 * is plain text (no GitHub-flavoured markdown affordances exposed at this
 * layer). The implementation may still render this as the PR body when the
 * underlying GitHub PR is created.
 */
export interface OpenChangeRequestInput {
  sourceBranch: string;
  targetBranch: string;
  title: string;
  description?: string;
}

/**
 * Result of asking the workflow to merge a change request. Mirrors
 * `MergePrResult` — caller learns the resulting change (commit) sha and the
 * timestamp the merge landed.
 *
 * When the merge attempt hits conflicts the workflow falls back to an
 * agent-driven resolution path; the caller does NOT get a `MergeChangeRequestResult`
 * back in that case — they get a `ConflictPending` shape instead so the UI
 * can route into the resolution flow.
 */
export type MergeChangeRequestOutcome =
  | { kind: 'merged'; result: MergeChangeRequestResult }
  | { kind: 'conflicts-need-resolution'; conflictedPaths: string[] };

/**
 * What a remote sync did to one branch's clone. One entry per branch in the
 * `POST /api/sync` response, so a pipeline can read exactly which branch
 * moved, which was already current, and which needs a person.
 *
 *  - `updated`     — the clone moved from `from` to `to`.
 *  - `up-to-date`  — origin had nothing new; `to` is the unchanged HEAD.
 *  - `not-cloned`  — Hexis has no clone of this branch, so there is nothing
 *                    to refresh (the first visit clones it fresh).
 *  - `conflict`    — Hexis-side commits contradict what landed on the host.
 *                    The clone is untouched; `error` is the message to show
 *                    and `conflictedPaths` the files a person must reconcile.
 *  - `error`       — the pull failed for another reason (origin unreachable,
 *                    credential refused); `error` is the sanitised message.
 */
export type BranchSyncOutcome =
  | { branch: string; outcome: 'updated'; from: string; to: string }
  | { branch: string; outcome: 'up-to-date'; to: string }
  | { branch: string; outcome: 'not-cloned' }
  | { branch: string; outcome: 'conflict'; conflictedPaths: string[]; error: string }
  | { branch: string; outcome: 'error'; error: string };
