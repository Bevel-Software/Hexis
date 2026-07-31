/**
 * The git configuration a per-branch workspace clone must have for its branch
 * to track exactly ONE upstream ref.
 *
 * Why this exists: a clone's config is append-only from git's point of view,
 * and several things write to it:
 *
 *   - `git config --add branch.<name>.merge …` / `git branch --set-upstream-to`
 *     run out of band (an agent shell session in the workspace, a manual fix)
 *     leaves a SECOND `branch.<name>.merge` value;
 *   - `git remote set-branches --add origin …`, a re-run `git remote add`, or a
 *     hand-edited `.git/config` leaves a SECOND `remote.origin.fetch` refspec,
 *     so one fetch maps the same remote branch in twice.
 *
 * A multi-valued `branch.<name>.merge` is what makes a BARE `git fetch origin`
 * write more than one *for-merge* entry into the clone's shared
 * `.git/FETCH_HEAD` — git adds one per configured merge ref. That is the
 * ammunition behind the reported failure: `git pull` reads its rebase target
 * out of that same shared file, so when one of the app's unmutexed bare
 * fetches lands inside the pull's fetch→read window, the pull sees two merge
 * heads and dies with `fatal: Cannot rebase onto multiple branches.`
 *
 * The drift alone is NOT sufficient — an explicit `git pull --rebase origin
 * <branch>` survives every drift shape on its own (verified across the shapes
 * above on git 2.39.5); it takes the concurrent fetch too. `GitService.pull`
 * closes the other half by never reading or writing FETCH_HEAD; normalising
 * the config here removes the ammunition.
 *
 * These are the three keys that pin the clone back to "this branch tracks
 * `origin/<branch>`, nothing else"; applied with `--replace-all` they collapse
 * any accumulated duplicates into one value.
 *
 * Lives here — next to `assertValidBranchName` — as a leaf-level primitive
 * shared by the git layer (self-heal before every pull) and `WorkspaceService`
 * (stamped on new clones, and re-stamped on existing ones the first time this
 * process opens them, which is the migration for clones already on disk).
 */

/** The single fetch refspec a workspace clone of the KB is created with. */
export const ORIGIN_FETCH_REFSPEC = '+refs/heads/*:refs/remotes/origin/*';

/**
 * The one safe shape for an implicit background fetch of a workspace clone —
 * shared by `GitService.fetchOriginIfStale` and
 * `WorkspaceService.ensureRemotesFetched`, both of which run OUTSIDE the
 * workspace mutex. `--no-write-fetch-head` is what makes that safe: without it
 * a bare fetch rewrites the clone's shared `.git/FETCH_HEAD` underneath
 * whatever else is running in it, which is how the post-merge `git pull` read
 * two merge heads and died with "Cannot rebase onto multiple branches" (see
 * the header comment above and `GitService.pull`). These paths only want the
 * remote-tracking refs refreshed; `--prune` keeps deleted remote branches from
 * lingering. Callers prepend their own runner context (`-C <dir>` /
 * `-c http.*` options) but must not vary these arguments.
 */
export const SAFE_IMPLICIT_FETCH_ARGS: readonly string[] = [
  'fetch', '--prune', '--no-write-fetch-head', 'origin',
];

/**
 * `git` argument lists that normalise a clone's tracking config for `branch`.
 * Returns the arguments rather than running them so each caller can use its own
 * git runner (the git service's mutex-aware wrapper, `git -C` from the
 * workspace service) — no process is spawned here.
 */
export function cloneTrackingConfigArgs(branch: string): string[][] {
  return [
    ['config', '--replace-all', 'remote.origin.fetch', ORIGIN_FETCH_REFSPEC],
    ['config', '--replace-all', `branch.${branch}.remote`, 'origin'],
    ['config', '--replace-all', `branch.${branch}.merge`, `refs/heads/${branch}`],
  ];
}
