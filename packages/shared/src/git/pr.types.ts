export type PullRequestState = 'open' | 'merged' | 'closed';

export interface PullRequestAuthor {
  login: string;
  name?: string;
}

export interface PullRequestReviewStatus {
  approvals: number;
  changesRequested: number;
  /** GitHub logins of reviewers with a pending request (no review yet). */
  pendingLogins: string[];
}

export interface PullRequestSummary {
  number: number;
  title: string;
  author: PullRequestAuthor;
  /**
   * Opaque SHA-256 hash of the authoring user's email. Embedded in the PR body via a hidden
   * marker so `/pr/mine` can filter by identity without leaking raw emails into bodies. Absent
   * on PRs not created through this backend. `author.login` is always the GitHub account that
   * actually opened the PR (typically our service account). Compare by re-hashing the caller's
   * email; there is no reverse lookup.
   */
  authorId?: string;
  /**
   * The app user (not the GitHub account) who triggered this PR. Resolved server-side by
   * matching `authorId` against the hash of every app user's email. Use this in user-facing
   * surfaces — `author.login` is always the shared service account.
   *
   * Display name only — no email. Other authenticated workspace members don't need raw
   * emails to render PR attribution. The hash in `authorId` is the stable identity if
   * downstream code needs to compare against the current user.
   *
   * Absent when no app user matches the hash (e.g. PRs opened outside this backend, or after
   * an app user was removed from the users table).
   */
  appAuthor?: { name: string };
  branch: string;
  base: string;
  state: PullRequestState;
  createdAt: string;
  /** Relative paths within `knowledge-base/`. Empty if not yet computed. */
  touchedNodePaths: string[];
  review: PullRequestReviewStatus;
  url: string;
}

export type PrFileStatus =
  | 'added'
  | 'modified'
  | 'removed'
  | 'renamed'
  | 'copied'
  | 'changed'
  | 'unchanged';

/**
 * A single file in a PR. Patch is GitHub's unified-diff text; it's absent for
 * binary files and for files larger than the API cutoff (~3 MB). `previousPath`
 * is populated for renames/copies.
 */
export interface PullRequestFile {
  path: string;
  previousPath?: string;
  status: PrFileStatus;
  additions: number;
  deletions: number;
  patch?: string;
  isBinary: boolean;
  /** Blob SHA at the PR head — stable identifier for caching raw content. */
  sha: string;
  /** Authenticated `raw.githubusercontent.com`-style URL for the blob at head. */
  rawUrl: string;
}

/**
 * One comment in the Bevel-owned PR discussion. GitHub never sees these —
 * they live only in our DB, attributed to the authenticated user. Shape
 * encodes three comment kinds:
 *
 *   General         → path undefined, line undefined
 *   File-level      → path set,      line undefined
 *   Inline (line)   → path set,      line set
 *
 * Threading: `parentId` points at the root of the thread; top-level comments
 * have it undefined.
 */
export interface PrReviewComment {
  id: string;
  author: { email: string; name: string };
  body: string;
  path?: string;
  line?: number;
  /** The head SHA the comment was authored against — lets the UI grey out stale inline pins. */
  headSha: string;
  parentId?: string;
  createdAt: string;
  updatedAt?: string;
}

export interface PostPrCommentInput {
  body: string;
  path?: string;
  line?: number;
  parentId?: string;
}

/**
 * One owner's approval on one file. Stored straight from the
 * `pr_file_approvals` row, with derived flags the UI needs.
 */
export interface FileApprovalEntry {
  email: string;
  name: string;
  approvedAt: string;
  /** True when this approval was captured against a SHA that is no longer the PR head. */
  isStale: boolean;
  /** True when the approver is the PR author (hash-matched against the PR body marker). */
  isSelfApproval: boolean;
}

/**
 * Per-file approval state the PR viewer needs to render the approval badge,
 * the Approve button, and the merge gate.
 *
 * `eligibleApprovers` lists everyone who could approve this file at the PR
 * head SHA, derived from the access tree (`roles.yaml` + `access.md`). A
 * file is approved when any non-author user holding one of those roles (or
 * directly named) submits a non-stale approval. The built-in role `everyone`
 * means any signed-in approver is eligible.
 */
export interface FileApprovalState {
  path: string;
  /**
   * Roles + direct user grants that confer write access on this file as of
   * the PR head. `roles` may include the built-in role `everyone`. Empty roles
   * + empty users means the file is outside the access-controlled surface (no
   * rule grants write); the merge gate silently excludes such entries instead
   * of blocking on them.
   */
  eligibleApprovers: {
    roles: string[];
    users: { name: string; email: string }[];
  };
  approvedBy: FileApprovalEntry[];
  /**
   * True iff at least one eligible approver has submitted a non-stale
   * approval. Always `false` when `eligibleApprovers` is empty — with no
   * eligible set, nobody can satisfy the check.
   * Whether the gate *cares* about this file is a separate concern handled
   * by the merge-gate logic: non-md files and files with no eligible
   * approvers are silently excluded from the gate, so `isApproved: false`
   * on one of them does not block merge.
   */
  isApproved: boolean;
  /**
   * Pre-computed for the requesting viewer: would `approveFile` accept their
   * click? True iff their email resolves to `write` on this path under the
   * access tree at `origin/<baseBranch>`. The frontend uses this to gate the
   * Approve button — without it, the button shows for any user whenever the
   * eligible-roles list is non-empty, which is misleading because most users
   * aren't actually in those roles. Backend remains authoritative; this is a
   * UX hint, not a security boundary.
   */
  viewerCanApprove: boolean;
}

/**
 * Full read-only PR detail for the in-app viewer. Extends the summary with
 * body, SHAs, file list, and the Bevel-owned comments. Later phases add
 * `approvals` and merge-gate fields — this shape grows incrementally.
 */
export interface PullRequestDetail extends PullRequestSummary {
  body: string;
  headSha: string;
  baseSha: string;
  files: PullRequestFile[];
  comments: PrReviewComment[];
  /**
   * One entry per file in `files`, same order. Empty when the caller had no
   * resolvable workspace to do the owner lookup against.
   */
  approvals: FileApprovalState[];
  /**
   * True iff no *hard* block applies — the PR is open, has files, and isn't
   * merged/closed. Soft warnings (missing owner approvals on md files) do
   * **not** set this to false; the UI handles them via the bypass dialog.
   * The button is disabled only when this is false.
   */
  mergeableInBevel: boolean;
  /**
   * Hard-block reasons — merging is impossible until these resolve (PR state,
   * no files, etc.). Empty when the PR can be merged (possibly after bypass).
   */
  mergeBlockedReasons: string[];
  /**
   * Soft warnings — md files with an owner who hasn't approved (or whose
   * approval is stale). Merging is allowed but the UI asks for an explicit
   * bypass confirmation first. Non-md files and ownerless md files are silent.
   */
  mergeWarnings: string[];
  /**
   * True iff the viewer holds write on `roles.yaml` at `origin/<base>` —
   * i.e. they're in the Admin role on the canonical access tree. The
   * frontend uses this to hide / disable the bypass action for non-admins;
   * the backend enforces the same check on the merge route. False when no
   * viewer was passed (anonymous detail fetch) or when the access tree on
   * base can't be resolved.
   */
  viewerCanBypassMerge: boolean;
  /**
   * True iff the viewer is allowed to cancel this change request: the PR is
   * open AND the viewer is either its author (hash-matched against the body
   * marker) or an admin (write on `roles.yaml` at `origin/<base>` — same
   * predicate `viewerCanBypassMerge` uses). The frontend renders the Cancel
   * button as disabled when this is false; the backend re-checks server-side
   * on `POST /pr/:n/cancel`, so this is a UX hint, not a security boundary.
   * False when no viewer was passed, the state isn't `open`, or the access
   * tree can't be resolved.
   */
  viewerCanCancel: boolean;
}

/**
 * Result of a successful merge via the in-app gate. `sha` is the merge commit
 * GitHub produced; the UI uses it to link to the resulting commit and to
 * invalidate any stale views.
 */
export interface MergePrResult {
  prNumber: number;
  sha: string;
  mergedAt: string;
}

/**
 * Result of a successful cancel via `POST /pr/:n/cancel`. No SHA — closing a
 * PR without merging produces no merge commit. `cancelledAt` is the
 * server-side timestamp the close was recorded; useful for audit display.
 */
export interface CancelPrResult {
  prNumber: number;
  cancelledAt: string;
}

export interface IPullRequestService {
  /**
   * `opts.fresh` bypasses the internal 30s list cache — used when the UI has
   * a reason to believe the server-side state just changed (agent-opened PR
   * via `gh pr create`) and the user expects to see the update immediately.
   */
  listOpenPrs(opts?: { fresh?: boolean }): Promise<PullRequestSummary[]>;
  listPrsAuthoredBy(githubLoginOrEmail: string): Promise<PullRequestSummary[]>;
  /**
   * PRs whose touched paths have an owner with the given email.
   * Resolution uses the given workspace's KB — caller passes their own workspaceId.
   */
  listPrsForOwnerEmail(
    workspaceId: string,
    email: string,
    opts?: { fresh?: boolean },
  ): Promise<PullRequestSummary[]>;
  getPr(prNumber: number): Promise<PullRequestSummary | null>;
  /**
   * Full detail for the in-app PR viewer. `opts.fresh` bypasses the detail cache
   * — use for event-driven refreshes (post-merge, share-dialog create).
   * `opts.viewerEmail` pre-computes `viewerCanApprove` per file.
   */
  getPrDetail(
    prNumber: number,
    opts?: { fresh?: boolean; workspaceId?: string; viewerEmail?: string },
  ): Promise<PullRequestDetail | null>;
}
