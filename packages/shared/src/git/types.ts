import type { AuthUser } from '../auth/types.js';
import type { PullRequestFile } from './pr.types.js';

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

export interface IGitService {
  status(workspaceId: string): Promise<WorkingTreeStatus>;
  listBranches(workspaceId: string, opts?: { freshFetch?: boolean }): Promise<BranchInfo[]>;
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
   */
  deleteBranch(
    workspaceId: string,
    name: string,
    user: AuthUser,
    opts?: { onlyIfNoRemote?: boolean },
  ): Promise<void>;
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
  pull(workspaceId: string): Promise<{ treeChanged: boolean }>;
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
   */
  changedPathsForPr(workspaceId: string, baseBranch: string, headBranch: string): Promise<string[]>;
}
