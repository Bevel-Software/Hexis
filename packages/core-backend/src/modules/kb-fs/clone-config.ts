/**
 * The git configuration a per-branch workspace clone must carry: the tracking
 * config that pins its branch to exactly ONE upstream ref, and the credential
 * helper its remote operations authenticate with.
 *
 * Both are stamped at clone time AND re-stamped when an existing clone is
 * adopted from disk, so a clone created by an older build — or by a path that
 * only authenticated its own invocation — is repaired rather than left broken.
 *
 * On the tracking half:
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

/**
 * The inline credential helper a workspace clone authenticates its remote
 * operations with, or null when the deployment has no git token configured.
 *
 * The snippet reads `$GITHUB_TOKEN` at CALL time, so the secret itself never
 * enters argv, the clone's `.git/config`, or any error message quoting either.
 * `GITHUB_TOKEN` is the normalised name — `CoreConfig` collapses `GIT_TOKEN` /
 * `GH_TOKEN` onto it at boot, and `DeploymentSettingsService.syncGitTokenEnv`
 * publishes a token supplied through the setup screen to the same place — so
 * this one name covers every way a token can arrive.
 *
 * The username is provider-specific (GitHub `x-access-token`, GitLab `oauth2`,
 * Bitbucket `x-token-auth`); the token is always the Basic-auth password,
 * which every major host accepts.
 */
export function credentialHelperValue(gitUsername: string): string | null {
  if (!process.env.GITHUB_TOKEN) return null;
  // Interpolated into a shell snippet that git will execute. `CoreConfig` and
  // `DeploymentSettingsService` both reject a username outside this charset
  // before it can get this far, so reaching the throw means an unvalidated
  // fourth path appeared — fail closed rather than emit an injectable helper.
  if (!/^[A-Za-z0-9._-]+$/.test(gitUsername)) {
    throw new Error(`git username must match [A-Za-z0-9._-]+; got "${gitUsername}"`);
  }
  return `!f() { echo "username=${gitUsername}"; echo "password=$GITHUB_TOKEN"; }; f`;
}

/**
 * `git clone` arguments that PERSIST the credential helper into the repository
 * being created. Position is load-bearing: these belong AFTER the `clone`
 * subcommand, where `--config` means "write this into the new repo's config".
 * The same pair placed BEFORE it is git's per-invocation `-c`, which
 * authenticates that one clone and leaves the resulting repo with no helper at
 * all — so every later `git push` from that clone prompts for a username,
 * finds no tty, and dies. That was a real outage: a self-hosted deployment
 * cloned fine, committed fine, and silently pushed nothing for two days.
 *
 * Empty when no token is configured, matching the un-authenticated clone the
 * rest of the layer already supports.
 */
export function cloneCredentialArgs(gitUsername: string): string[] {
  const helper = credentialHelperValue(gitUsername);
  return helper ? ['--config', `credential.helper=${helper}`] : [];
}

/**
 * `git` argument lists that stamp the credential helper onto a clone that
 * ALREADY exists — the repair path for clones on disk that were created
 * without one (see `cloneCredentialArgs`), applied wherever
 * `cloneTrackingConfigArgs` is. `--replace-all` collapses any accumulated
 * values, so re-stamping is idempotent and a stale helper cannot survive.
 *
 * Returns the arguments rather than running them, for the same reason
 * `cloneTrackingConfigArgs` does.
 */
export function cloneCredentialConfigArgs(gitUsername: string): string[][] {
  const helper = credentialHelperValue(gitUsername);
  return helper ? [['config', '--replace-all', 'credential.helper', helper]] : [];
}
