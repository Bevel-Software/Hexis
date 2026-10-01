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
