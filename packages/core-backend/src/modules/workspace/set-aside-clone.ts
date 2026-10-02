import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Moving a working copy of a repository that is no longer the configured one
 * OUT OF THE WAY, rather than deleting it.
 *
 * Two places find such a clone: the KB startup phase, sweeping the whole
 * workspaces root at boot and on the save that changes the address, and the
 * workspace service, refusing to adopt one it finds on disk. Both must do the
 * same thing with it, because what is in it is the same thing: commits that
 * may exist nowhere else. A clone fetches and pushes through the address in
 * its own `remote.origin.url`, and two repositories need not share a commit,
 * so such a clone cannot be re-pointed — but that is a reason not to USE it,
 * never a reason to destroy it.
 */

/**
 * Where working copies are set aside. NOT under the workspaces root: the
 * workspace service's orphan sweep removes every folder there that is not a
 * known branch's, and what is set aside has to outlive that sweep.
 *
 * PASS THE OVERRIDE, and pass BOTH CALLERS THE SAME ONE. The fallback is a
 * sibling of the workspaces root, which is a lasting place only when that
 * parent is itself a mounted volume — in the shipped compose file it is the
 * container's own filesystem, so a copy left there is gone at the next
 * recreate, having been kept on the promise that it would not be. The
 * composition root therefore roots both the startup phase and the workspace
 * service at one directory under the backups volume; the fallback is for a
 * test, or a caller with no deployment layout to speak of.
 */
export function setAsideRootFor(workspacesRoot: string, override?: string): string {
  return override ?? path.resolve(workspacesRoot, '..', 'replaced-working-copies');
}

/**
 * One folder per occasion, so what was set aside together stays together and
 * two replacements never land in each other's folder.
 */
export function setAsideStamp(at: Date = new Date()): string {
  return at.toISOString().replace(/[:.]/g, '-');
}

/**
 * Move the clone at `repoDir` to `dest`. A rename when it can be one; a copy
 * when it cannot (another volume, a handle held open on it), and only then is
 * the original removed — so a copy that fails leaves the clone exactly where
 * it was rather than half of it in each place.
 *
 * Throws with what to do about it. The caller decides how much that costs:
 * the startup phase stops the boot (leaving the clone would fail a step later
 * with git's words about a repository nobody configured), while a single
 * branch open refuses that branch.
 */
export async function setAsideClone(repoDir: string, dest: string): Promise<void> {
  // A destination that is already there is somebody's set-aside work, and
  // never this call's to touch: the copy below cleans up after itself by
  // removing the destination, which must then be one this call made.
  if (await fs.access(dest).then(() => true, () => false)) {
    throw new Error(
      `Could not set aside the working copy at ${repoDir}: ${dest} already holds one. Nothing was deleted or ` +
        'moved. Try again; the folder is named for the moment it is made.',
    );
  }
  await fs.mkdir(path.dirname(dest), { recursive: true });
  try {
    await fs.rename(repoDir, dest);
    return;
  } catch {
    // Another volume, or a handle held open on it: copy instead.
  }
  try {
    await fs.cp(repoDir, dest, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
  } catch (err) {
    await fs.rm(dest, { recursive: true, force: true }).catch(() => undefined);
    throw new Error(
      `Could not set aside the working copy at ${repoDir}, a clone of a repository that is no longer the ` +
        `configured one, into ${dest}: ${err instanceof Error ? err.message : String(err)}. Nothing was deleted. ` +
        'Make room there, or move that folder away by hand, and start again.',
      { cause: err },
    );
  }
  await fs.rm(repoDir, { recursive: true, force: true });
}
