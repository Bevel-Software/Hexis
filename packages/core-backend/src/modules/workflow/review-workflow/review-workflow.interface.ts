import type {
  AuthUser,
  CancelPrResult,
  FileApprovalState,
  MergePrResult,
  PostPrCommentInput,
  PrReviewComment,
  PullRequestFile,
  PullRequestState,
} from '@bevel-software/platform-shared';

export interface MergeGateInput {
  prNumber: number;
  state: PullRequestState;
  approvals: FileApprovalState[];
}

export interface MergeGateResult {
  /** False only on hard blocks (PR closed/merged, zero files). Warnings do NOT flip this false. */
  mergeable: boolean;
  /** Hard-block reasons — merge cannot proceed until these resolve. */
  reasons: string[];
  /**
   * Soft warnings — md files with an owner who hasn't approved (or whose
   * approval is stale). Merge proceeds only when the caller explicitly opts
   * into bypass; the frontend surfaces these in a confirm dialog.
   */
  warnings: string[];
}

/**
 * Owns the Bevel-side review state for a PR: comments (phase 2), per-file
 * approvals (phase 3), and the merge gate (phase 4). GitHub stays authoritative
 * for the diff + eventual merge; everything in this interface is in-app state
 * the team uses to decide whether the merge should fire.
 */
export interface IReviewWorkflowService {
  /** List all comments for a PR, oldest first. */
  listComments(prNumber: number): Promise<PrReviewComment[]>;

  /** Post a new comment. Shape of `input` decides whether it's general, file-level, or inline. */
  postComment(
    prNumber: number,
    user: AuthUser,
    input: PostPrCommentInput,
    headSha: string,
  ): Promise<PrReviewComment>;

  /**
   * Edit an existing comment. Only the original author may edit — 403 otherwise.
   * `prNumber` scopes the lookup so a caller can't touch a comment from a
   * different PR via a guessed id; the comment must belong to this PR.
   */
  editComment(
    commentId: string,
    prNumber: number,
    user: AuthUser,
    body: string,
  ): Promise<PrReviewComment>;

  /**
   * Delete a comment. Only the original author may delete — 403 otherwise.
   * Replies are preserved (orphaned to the thread root). `prNumber` scopes the
   * lookup so a caller can't cross PRs via a guessed id.
   */
  deleteComment(commentId: string, prNumber: number, user: AuthUser): Promise<void>;

  /**
   * Compose the per-file approval state for a PR detail response. Resolves
   * the eligible approver set against **the PR's base branch on origin**
   * (e.g. `origin/current-company-state`), then joins approval rows from
   * the DB, marking stale approvals and flagging self-approvals.
   *
   * Why base, not head: the PR's head can carry arbitrary edits to
   * `roles.yaml` or `access.md`, so resolving against head would let a PR
   * author grant themselves approval rights by editing access config in
   * their own branch. The base is fast-forward-only (protected branches
   * are gated by their own PR review), so it's the authoritative source
   * for "who has write access to this path right now."
   *
   * `workspaceId` is optional. When omitted (or when the access lookup
   * fails — e.g. the workspace hasn't fetched `origin/<base>` yet), the
   * result is still one `FileApprovalState` per input file but with empty
   * eligibility. Downstream the merge gate treats empty-eligibility entries
   * as silent (outside the gate), so a missing workspace degrades to
   * "PR detail renders, approval gating unavailable" rather than a hard
   * failure.
   */
  getApprovalStates(
    prNumber: number,
    files: PullRequestFile[],
    headSha: string,
    baseBranch: string,
    prAuthorIdHash: string | null,
    workspaceId?: string,
    /**
     * Email of the user viewing the PR. When provided, each returned state
     * carries `viewerCanApprove` populated from the access tree at
     * `origin/<baseBranch>`. Omitted (or absent workspace) → `viewerCanApprove`
     * defaults to `false` everywhere.
     */
    viewerEmail?: string,
  ): Promise<FileApprovalState[]>;

  /**
   * Approve one file. Requires the caller to hold `write` on the path per
   * the access tree on `origin/<baseBranch>` (403 otherwise). Idempotent —
   * approving twice on the same headSha is a no-op. Returns the fresh
   * composite state for all files.
   */
  approveFile(
    prNumber: number,
    path: string,
    user: AuthUser,
    files: PullRequestFile[],
    headSha: string,
    baseBranch: string,
    prAuthorIdHash: string | null,
    workspaceId: string,
  ): Promise<FileApprovalState[]>;

  /**
   * Revoke the caller's own approval on one file. Non-author users cannot
   * revoke someone else's approval (403). Idempotent when no matching
   * approval exists.
   */
  unapproveFile(
    prNumber: number,
    path: string,
    user: AuthUser,
    files: PullRequestFile[],
    headSha: string,
    baseBranch: string,
    prAuthorIdHash: string | null,
    workspaceId: string,
  ): Promise<FileApprovalState[]>;

  /**
   * Pure derivation of the merge gate from PR state + per-file approvals.
   * Exposed as a method (not a free function) so the HTTP response and the
   * merge route re-validate via the same code path.
   */
  evaluateMergeGate(input: MergeGateInput): MergeGateResult;

  /**
   * Execute the merge via a local `git merge --no-ff` on the base branch's
   * workspace, pushed to origin (provider-agnostic — no PR API). Re-validates
   * the gate server-side first (don't trust the caller's cached
   * `mergeableInBevel`), writes a row to `pr_merge_log` bracketing the attempt,
   * flips the `change_requests` row to `merged`, and tags the merge commit with
   * the real triggerer so the audit trail lives on the commit. Conflicts throw
   * `ChangeRequestConflictsError` (409) with the conflicting paths.
   *
   * **Merge authority invariant**: this method is the *only* backend code path
   * that lands a change request on a protected branch.
   */
  mergePr(
    prNumber: number,
    user: AuthUser,
    /** Fresh detail fetched within the request — used for the gate and the head SHA. */
    headSha: string,
    approvals: FileApprovalState[],
    state: PullRequestState,
    prTitle: string,
    /** The PR's base branch — used to resolve admin status at `origin/<base>` for bypass. */
    baseBranch: string,
    /** Workspace clone — used for the access-tree lookup that gates bypass. */
    workspaceId: string,
    /**
     * When true, proceed even if soft warnings (unapproved md-with-owner files)
     * exist. Hard blocks are refused regardless. The bypassed warnings are
     * recorded in the merge commit body for audit. Bypass requires admin
     * write access at `origin/<baseBranch>` (i.e. write on `roles.yaml`) —
     * non-admins get a 403 even when warnings would otherwise be skippable.
     */
    opts?: { bypass?: boolean },
  ): Promise<MergePrResult>;

  /**
   * Close a change request without merging — flips the `change_requests` row to
   * `closed` (guarded on `state = 'open'`). Authorized when the caller is the PR
   * author (hash-matched against `authorIdHash`) OR an admin on the base branch
   * (write on `roles.yaml` at `origin/<baseBranch>` — the same predicate
   * `mergePr`'s bypass uses). Refused with 422 when the CR is already merged or
   * closed. The source branch is left intact.
   */
  cancelPr(
    prNumber: number,
    user: AuthUser,
    /** The PR's current state per a fresh `getPrDetail` fetch. */
    state: PullRequestState,
    /** Hash of the PR-author email from the body marker — null when absent. */
    authorIdHash: string | null,
    /** The PR's base branch — used to resolve admin authority at `origin/<base>`. */
    baseBranch: string,
    /** Workspace clone — used for the access-tree lookup that gates admin authority. */
    workspaceId: string,
  ): Promise<CancelPrResult>;
}
