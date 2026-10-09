import type { AuthUser } from '../auth/types.js';
import type { AppliedChangeRef, ChangedPathPair, PullRequestFile } from './pr.types.js';

export interface BranchInfo {
  name: string;
  isProtected: boolean;
  // Commits ahead/behind the branch's upstream (falls back to the nearest
  // protected branch on origin). Null when neither can be resolved, e.g. a
  // freshly-created local branch that has never been pushed.
  ahead: number | null;
  behind: number | null;
  /**
   * True iff `refs/remotes/origin/<name>` exists after the last `fetch --prune`.
   * False means the branch is local-only — either never pushed, or its remote
   * counterpart was deleted (typically after a PR merged + branch cleanup on
   * GitHub). The UI uses this to offer a "delete local branch" affordance.
   */
  hasRemote: boolean;
  // `isCurrent` removed: under the per-branch workspace model the workspace
  // IS the current branch — every consumer can derive it as
  // `branch.name === decodeURIComponent(workspaceId)`. The server-side
  // `git rev-parse` that used to compute this is no longer needed.
}

/**
 * Per-workspace branch sync state. Slimmed down from the legacy
 * "one workspace, many branches via checkout" model: fields like `isDirty`,
 * `unpushedCommits`, and `conflicted` are gone because save=share guarantees
 * the working tree is never dirty, there are no committed-but-unpushed
 * commits, and conflicts are resolved before lock release. What's left is
 * the upstream-sync signal that drives the auto-update flow + the branch
 * name (kept as a server-side cross-check against the URL-derived branch).
 */
export interface WorkingTreeStatus {
  branch: string;
  // False when the current branch has no configured upstream — typically a
  // freshly-created local draft that has never been pushed. Drives the
  // "this draft has never been shared" affordance.
  hasUpstream: boolean;
  // True when origin/<branch> has commits this clone hasn't merged in yet —
  // e.g. a teammate pushed to the same branch from their workspace. The
  // auto-pull hook + PullNeededBanner key off this; everything else has
  // gone with the legacy dirty-tree model.
  unmergedFromUpstream: boolean;
}

// `WorkingTreeFile` + `WorkingTreeFileStatus` removed: the working tree is
// never dirty under save=share, so the "list dirty files with their per-file
// status" surface has no meaningful content.

export interface CommitAttribution {
  authorName: string;
  authorEmail: string;
  sha: string;
  subject: string;
  committedAt: string;
}

export interface ShareChangesRequest {
  summary: string;
  description?: string;
}

export interface ValidationReport {
  ok: boolean;
  mustFix: string[];
  warnings: string[];
  rawOutput: string;
}

/** What `IGitService.syncFromRemote` observed under its one hold of the clone. */
export interface RemoteSyncPullResult {
  /** HEAD before the pull; null when the clone had no commits yet. */
  before: string | null;
  /** HEAD after the pull; null only when origin is still empty too. */
  after: string | null;
  /** Whether the working tree's CONTENT differs — tree ids, not commit ids. */
  treeChanged: boolean;
  /** Repo-relative paths whose content changed; empty unless `treeChanged`. */
  changedPaths: string[];
}

export interface IGitService {
  status(workspaceId: string): Promise<WorkingTreeStatus>;
  listBranches(workspaceId: string, opts?: { freshFetch?: boolean; strictFetch?: boolean }): Promise<BranchInfo[]>;
  createBranch(
    workspaceId: string,
    name: string,
    fromBase?: string,
  ): Promise<BranchInfo>;
  // No `switchBranch` here on purpose — see the comment in IWorkflowService.
  // Branch is workspace identity under the per-branch workspace model.
  /**
   * Delete a branch. Removes the local ref (if present) AND the origin ref
   * (if present); both sides go in one call so the picker's "discard draft"
   * affordance leaves no orphan behind.
   *
   * Authorisation: the branch's author OR an admin can delete it. Authorship
   * is inferred from the `<email-localpart>/...` naming convention — see
   * `isBranchAuthoredBy`. Admins (per the workspace's `roles.yaml`) can
   * additionally remove unprefixed CLI-created branches that have no
   * recognisable author.
   *
   * `onlyIfNoRemote: true` is the legacy orphan-cleanup path used after a
   * PR merge prunes the remote head: it BYPASSES the author/admin check
   * (callers prune any orphan they encounter) and REFUSES if origin still
   * has the ref (the safety property the flag has always provided).
   * Protected branches and the currently-checked-out branch are always
   * rejected.
   *
   * Answers the tip the branch had (origin's when it had one), or null when
   * there was none — what a restore of the branch would start from.
   */
  deleteBranch(
    workspaceId: string,
    name: string,
    user: AuthUser,
    opts?: { onlyIfNoRemote?: boolean },
  ): Promise<{ lastCommit: string | null }>;
  // `forkCurrentToDraft` removed: under the per-branch workspace model each
  // branch is its own workspace by construction, so the "carry uncommitted
  // edits onto a new draft" escape hatch can't fire. Use `createBranch` +
  // workspace-bootstrap navigation instead.
  //
  // `discardChanges` removed: under save=share the working tree is never
  // dirty, so there's nothing to discard.
  commit(
    workspaceId: string,
    user: AuthUser,
    req: ShareChangesRequest,
  ): Promise<CommitAttribution>;
  push(
    workspaceId: string,
    user: AuthUser,
    opts?: {
      /**
       * Skip the per-user protected-branch access gate for THIS push. Only
       * for system-authorized flows whose endpoint is itself the
       * authorization (plugin provisioning: any signed-in user may claim an
       * unused name under `Plugins/`, and the seeded access.md governs
       * everything after). Never thread a raw user request into this.
       */
      systemAuthorized?: boolean;
    },
  ): Promise<void>;
  fetch(workspaceId: string): Promise<void>;
  /**
   * `treeChanged` is whether the pull left the working tree holding different
   * CONTENT than before the call — tree ids compared, not commit ids, so a
   * pull that only moves HEAD across content-identical commits (an empty
   * commit, a rebase that replays to the same result) reports false. Only the
   * pull itself can answer that (it holds the workspace mutex across the
   * rebase; any before/after probe a caller ran around it would race), and
   * callers that announce "this tree changed" to the rest of the process need
   * the distinction: an "already up to date" pull that broadcast anyway would
   * drop every catalog cache and reload every attached browser for nothing.
   */
  pull(
    workspaceId: string,
    opts?: {
      /**
       * Replay the local commits with `--rebase-merges`, so a merge commit
       * the clone holds but origin has not seen survives the replay AS a
       * merge instead of being flattened into cherry-picks of its second
       * parent's commits. Only the change-request update asks for it: it is
       * the one caller whose unpushed commit is deliberately a merge, and
       * whose whole point is that the merge reaches the remote intact.
       */
      preserveMerges?: boolean;
    },
  ): Promise<{ treeChanged: boolean }>;
  /**
   * The remote sync's pull, observed as ONE serialized operation: where HEAD
   * was, the pull, where HEAD is, and which repo-relative paths changed
   * (rename-aware: both ends). `pull` bracketed by separate reads would let a
   * concurrent save land between them and be announced as the sync's own.
   *
   * Tolerant of an unborn HEAD (a clone of an empty upstream): `before` is
   * null, and paths are diffed against the empty tree. Throws the typed
   * pull-conflict error like `pull`, and a typed "remote branch gone" error
   * when origin no longer has the branch — including for an unborn clone,
   * once origin has any branch at all. The one exception: an unborn clone
   * against an origin with NO branches (a fresh deployment nobody has pushed
   * to) resolves to `after: null`, since there is nothing to sync and nothing
   * stale.
   */
  syncFromRemote(workspaceId: string): Promise<RemoteSyncPullResult>;
  /**
   * Whether origin still has `branch` right now (`ls-remote`). Used to
   * revalidate that a clone is still stale before it is retired.
   */
  remoteBranchExists(workspaceId: string, branch: string): Promise<boolean>;
  diffStat(workspaceId: string, base?: string): Promise<string[]>;
  /**
   * Paths in the working tree that the next commit would include — the set
   * `git add -A` would stage: modified + deleted + renamed + untracked files
   * (honouring `.gitignore`). Use this for share-dialog previews; for the
   * committed delta vs a base ref (e.g. PR owner lookup), use `diffStat`.
   */
  pendingChanges(workspaceId: string): Promise<string[]>;
  /**
   * Best-fit protected branch a feature branch was forked from, resolved by
   * picking whichever protected branch on origin yields the smallest "ahead"
   * count. Returns null if no protected branch can be reached.
   */
  resolveForkBase(workspaceId: string, branch: string): Promise<string | null>;
  logForFile(
    workspaceId: string,
    relativePath: string,
    limit?: number,
  ): Promise<CommitAttribution[]>;
  diffFileAtCommit(
    workspaceId: string,
    relativePath: string,
    sha: string,
  ): Promise<string>;
  /**
   * Unified diff of a single file between two branches. Both names must
   * resolve to a known branch on this workspace (local head or
   * `refs/remotes/origin/<name>`); arbitrary refspecs and SHAs are
   * rejected upstream. Returns the raw `git diff` output — empty string
   * when the file is identical on both sides, a unified-diff body
   * otherwise (including the "new file mode" / "deleted file mode"
   * headers when the file only exists on one side).
   *
   * Read-only: nothing is checked out, fetched, or written.
   */
  diffFileBetweenBranches(
    workspaceId: string,
    relativePath: string,
    fromBranch: string,
    toBranch: string,
  ): Promise<string>;
  // `workingStatus` + `diffFileWorking` removed: under save=share the
  // working tree is never dirty, so listing dirty files / diffing them
  // against HEAD reports the empty state by definition. Cross-branch
  // comparison (`diffFileBetweenBranches`) + history (`diffFileAtCommit`)
  // still cover the meaningful diff cases.

  /**
   * Head and base commit SHAs of a change request, resolved on `origin/*`
   * after a fetch so a force-push is reflected. These are what approvals
   * pin against, and what `changedFilesForPr`'s `at` option takes.
   */
  resolvePrShas(
    workspaceId: string,
    baseBranch: string,
    headBranch: string,
  ): Promise<{ baseSha: string; headSha: string }>;

  /**
   * The changed-file list of a change request: a three-dot (merge-base)
   * diff, rename-aware. `patchCap` bounds per-file patch generation (`0`
   * skips it); `at` pins the diff to commits the caller has already
   * resolved, skipping the fetch and the ref resolution.
   */
  changedFilesForPr(
    workspaceId: string,
    baseBranch: string,
    headBranch: string,
    opts?: { patchCap?: number; at?: { baseSha: string; headSha: string } },
  ): Promise<PullRequestFile[]>;

  /**
   * Just the repo-relative paths a change request touches (three-dot diff,
   * no statuses, no patches): the cheap form behind change-request list
   * summaries and owner routing.
   *
   * `fetch: false` skips the per-request fetch of the two refs — for a caller
   * that has just refreshed the whole clone's remote-tracking refs in one
   * round trip, which is what a LIST does rather than paying one fetch per
   * request. Pass it only when that is true; otherwise the diff can describe
   * a stale head. It is a skip, not a promise: a branch the clone does not
   * have yet is fetched anyway, since there is nothing to diff without it —
   * so a list's first sight of a new request still costs one round trip.
   */
  changedPathsForPr(
    workspaceId: string,
    baseBranch: string,
    headBranch: string,
    opts?: { fetch?: boolean },
  ): Promise<string[]>;

  /**
   * `changedPathsForPr`'s answer AND the same diff left as rename-aware pairs,
   * from ONE `git diff`.
   *
   * The flat list cannot pair a rename's two paths: git reports a rename under
   * its new name, and `forAccessCheck` adds the old name to the same
   * undifferentiated set. That union is enough to authorize a WRITE ("may they
   * touch everything this lands?"), but not to decide a READ — a file renamed
   * out of a folder the caller cannot open is readable under neither of its
   * names, since the diff of a rename shows the old side's content, and
   * deciding that needs to know which old path belongs to which new file. The
   * change-request read tools gate their file lists on exactly this, and the
   * list of requests must reach the same verdict as the detail of one.
   */
  changedPathsAndPairsForPr(
    workspaceId: string,
    baseBranch: string,
    headBranch: string,
    opts?: { fetch?: boolean },
  ): Promise<{ paths: string[]; pairs: ChangedPathPair[] }>;

  /**
   * The changed-file list an APPLIED change request landed, read from its merge
   * commit against that commit's first parent.
   *
   * Its source branch is retired, so the branch pair the other two methods want
   * no longer exists; what is left is the merge commit the row records. Its
   * first parent is the target as it stood before the merge, so the two-dot diff
   * between them is precisely what the request applied — and immutable, which
   * the branch pair never was.
   *
   * The commit is VERIFIED to be that request's own, which is why the ref
   * carries the number as well as the sha: a merge with nothing to merge used to
   * record the target tip, and reading that commit's change would answer with
   * another request's files. It must be in the clone, have a second parent, and
   * carry a subject naming this request; anything else rejects with
   * `WorkflowValidationError`, which every caller reads as "the file set could
   * not be resolved" and answers fail-closed (no files, so author-only) rather
   * than reaching for a fetch per request.
   *
   * No network, either way.
   */
  changedFilesOfAppliedChange(
    workspaceId: string,
    applied: AppliedChangeRef,
    opts?: { patchCap?: number },
  ): Promise<PullRequestFile[]>;

  /**
   * The same applied change as the two path views a change-request SUMMARY
   * needs, out of one `git diff` — `changedPathsAndPairsForPr` for an applied
   * request instead of a branch pair, with the same verification and the same
   * no-network contract as {@link changedFilesOfAppliedChange}.
   */
  changedPathsAndPairsOfAppliedChange(
    workspaceId: string,
    applied: AppliedChangeRef,
  ): Promise<{ paths: string[]; pairs: ChangedPathPair[] }>;

  /**
   * The two commits an APPLIED change request spanned, recovered from its merge
   * commit: the target before the merge (`^1`) and the source tip that was
   * merged (`^2`).
   *
   * The head matters beyond being informative: an approval is called stale when
   * the head it was given against is not the detail's `headSha`, so answering
   * the merge commit there would report every approval a merged request ever
   * collected as stale. Same verification, same no-network contract and the same
   * `WorkflowValidationError` as {@link changedFilesOfAppliedChange}.
   */
  appliedChangeShas(
    workspaceId: string,
    applied: AppliedChangeRef,
  ): Promise<{ baseSha: string; headSha: string }>;

  /**
   * A change request's fork point (merge base of the two resolved commits)
   * and whether the target has commits the proposal does not contain. No
   * fetch: `at` is what `resolvePrShas` just returned.
   */
  forkPointForPr(
    workspaceId: string,
    at: { baseSha: string; headSha: string },
  ): Promise<{ mergeBaseSha: string | null; behind: boolean }>;

  /**
   * Every repo-relative path whose content differs between two commits, as a
   * plain two-dot diff with rename detection OFF — so a rename reports both
   * the path it left and the path it arrived at. Two callers want exactly
   * that conservative answer: the approvals carry-forward (a path that
   * appears loses its approval) and "did the target change a file this
   * request also changes" (a request editing a file the target renamed has
   * to count as affected).
   */
  pathsChangedBetween(
    workspaceId: string,
    fromSha: string,
    toSha: string,
  ): Promise<string[]>;

  /**
   * A file's content at a change request's fork point — a commit that must
   * be on `baseBranch`'s history. `null` when the path did not exist there.
   */
  readFileAtForkPoint(
    workspaceId: string,
    baseBranch: string,
    sha: string,
    relativePath: string,
  ): Promise<string | null>;
}
