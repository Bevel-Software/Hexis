/**
 * The `git` floor this app depends on.
 *
 * Every fetch the workspace layer runs passes `--no-write-fetch-head` — the
 * option that keeps one clone's fetches from steering a concurrent refresh
 * through the shared `.git/FETCH_HEAD` (see `GitService.pull`) — and git only
 * learned it in 2.29. On an older binary every one of those fetches dies with
 * `unknown option`, which takes out `pull`, `resetToRemote` and
 * `mergeChangeRequest` at once.
 *
 * The production image installs git from Debian via `node:22-slim`, which is
 * well past the floor, so this guard is about a re-based or swapped runtime
 * image rather than a live problem. Its value is *when* it fires: at boot,
 * naming the installed version, instead of at the first change-request merge
 * with an opaque git error.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Oldest git that understands `--no-write-fetch-head`. */
export const MIN_GIT_VERSION: readonly [number, number] = [2, 29];

/** `git version 2.39.5 (Apple Git-154)` → `[2, 39]`; null if unrecognisable. */
export function parseGitVersion(stdout: string): [number, number] | null {
  const m = /^git version (\d+)\.(\d+)/.exec(stdout.trim());
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/**
 * Throw when `git --version` output names a version below the floor.
 *
 * An output we can't parse is NOT fatal: a git build with an unusual version
 * string is far more likely than one older than 2.29, and refusing to boot over
 * an unrecognised string would be a worse failure than the one being guarded.
 */
export function assertSupportedGitVersion(stdout: string): void {
  const found = parseGitVersion(stdout);
  const [minMajor, minMinor] = MIN_GIT_VERSION;
  if (!found) {
    console.warn(
      `[git] could not read a version from "${stdout.trim()}" — ` +
        `skipping the git ${minMajor}.${minMinor}+ check`,
    );
    return;
  }
  const [major, minor] = found;
  if (major > minMajor || (major === minMajor && minor >= minMinor)) return;
  throw new Error(
    `git ${minMajor}.${minMinor} or newer is required, found ${major}.${minor}. ` +
      'Every workspace fetch passes --no-write-fetch-head, which older git rejects, ' +
      'so branch refresh and change-request merges cannot work on this runtime.',
  );
}

/**
 * Run `git --version` and apply the floor. Call once during startup, before
 * anything clones or fetches.
 */
export async function assertGitVersion(): Promise<void> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('git', ['--version']));
  } catch (err) {
    throw new Error(`git is required but could not be run: ${String(err)}`);
  }
  assertSupportedGitVersion(stdout);
}
