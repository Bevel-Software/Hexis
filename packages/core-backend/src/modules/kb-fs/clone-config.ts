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
  // printf '%s' rather than echo: POSIX leaves echo's handling of backslash
  // escapes implementation-defined (dash interprets \c as "stop output"), so
  // a token containing a backslash sequence could be silently truncated on
  // the way to git. printf %s passes the bytes through verbatim. The literal
  // `password=$GITHUB_TOKEN` stays in the snippet, which is what
  // APP_HELPER_VALUE_PATTERN keys on — echo-era helpers stamped by earlier
  // builds still match it and get replaced on the next stamp.
  return `!f() { printf '%s\\n' "username=${gitUsername}" "password=$GITHUB_TOKEN"; }; f`;
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
 * `git` argument lists that bring a clone's credential helper into line with
 * the deployment's current config — the repair path for clones on disk (see
 * `cloneCredentialArgs`), applied wherever `cloneTrackingConfigArgs` is:
 * `--replace-all` when a token is configured (idempotent re-stamp, stale
 * values collapse), `--unset-all` when the deployment lost its token (a
 * leftover helper answering with an empty password must not shadow whatever
 * auth the operator fell back to; unset of a missing value exits non-zero
 * and callers tolerate it — see `stampCredentialHelper`). Both operations
 * are scoped by the value pattern below so only app-owned helpers are
 * touched. Returns the arguments rather than running them, for the same
 * reason `cloneTrackingConfigArgs` does.
 */
/**
 * Value pattern (a POSIX ERE, as `git config`'s optional value-pattern
 * argument expects) that matches ONLY helpers this application stamped —
 * every one of ours reads `password=$GITHUB_TOKEN`, and no operator-authored
 * helper has a reason to contain that literal. Scoping both the replace and
 * the unset to it means an operator's own clone-local helper (`store`,
 * `cache`, something custom) is never collapsed away or deleted by our
 * stamping: git chains all configured helpers in order, so ours and theirs
 * coexist.
 */
const APP_HELPER_VALUE_PATTERN = 'password=\\$GITHUB_TOKEN';

export function cloneCredentialConfigArgs(gitUsername: string): string[][] {
  const helper = credentialHelperValue(gitUsername);
  // `--replace-all key value pattern` replaces every line MATCHING the
  // pattern with the one value (adding it when none match) and leaves
  // non-matching values — operator helpers — untouched. Same scoping on the
  // unset: only app-stamped values are removed when the token goes away.
  return helper
    ? [['config', '--replace-all', 'credential.helper', helper, APP_HELPER_VALUE_PATTERN]]
    : [['config', '--unset-all', 'credential.helper', APP_HELPER_VALUE_PATTERN]];
}
