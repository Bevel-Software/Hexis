import { promises as fs } from 'node:fs';
import path from 'node:path';
import { logger } from '../../shared/logging.js';
import { isAbsence } from '../../shared/fs.contract.js';
import { readGitfile } from './kb-repository.js';
import type { IKbRepository } from './kb-repository.contract.js';

const log = logger('set-aside');

/**
 * `p` as the file system names it, for comparing two paths that may be
 * spelled differently: git writes a worktree's link with forward slashes and
 * the long folder names (`C:/Users/runneradmin/…`) where node may hold the
 * same folder by its 8.3 short name (`C:\Users\RUNNER~1\…`). The nearest
 * part that exists is resolved by the OS, the rest appended; on Windows the
 * result is case-folded, as its file system is. Only an absent part is
 * stepped over: a part that cannot be read (a permission or I/O error) throws,
 * since "could not tell" is no reason to move someone's worktree.
 */
async function comparablePath(p: string): Promise<string> {
  let existing = path.resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      existing = await fs.realpath(existing);
      break;
    } catch (err) {
      if (!isAbsence(err)) throw err;
      const parent = path.dirname(existing);
      if (parent === existing) break;
      rest.unshift(path.basename(existing));
      existing = parent;
    }
  }
  const joined = path.join(existing, ...rest);
  return process.platform === 'win32' ? joined.toLowerCase() : joined;
}

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
  const taken = (): Error =>
    new Error(
      `Could not set aside the working copy at ${repoDir}: ${dest} already holds one. Nothing was deleted or ` +
        'moved. Try again; the folder is named for the moment it is made.',
    );
  if (await fs.access(dest).then(() => true, () => false)) throw taken();
  await fs.mkdir(path.dirname(dest), { recursive: true });
  try {
    await fs.rename(repoDir, dest);
    return;
  } catch {
    // Another volume, or a handle held open on it: copy instead.
  }
  // The destination is MADE here, by the one call that will fill it. Two
  // calls that both found it absent above cannot both make it: the second
  // is refused by the filesystem, before the cleanup below could ever be
  // about a folder it did not create.
  try {
    await fs.mkdir(dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw taken();
    throw err;
  }
  try {
    // Into the empty folder made above, which is why an existing destination
    // is not an error here; nothing is overwritten (`force: false`).
    await fs.cp(repoDir, dest, { recursive: true, errorOnExist: false, force: false, verbatimSymlinks: true });
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

/**
 * Set aside the knowledge base's repository AND EVERY WORKTREE OF IT, together,
 * into `dest`: each worktree's folder as `dest/<workspace id>` (where a clone
 * lands), the repository beside them under its own name.
 *
 * Together, because neither is any use without the other: a worktree's
 * commits live in the repository, and a repository of another address is
 * exactly as unusable as a clone of one. Nothing is deleted. The moved
 * worktrees are re-linked to the moved repository, so `git log` in
 * `dest/<workspace id>` shows the work that was never pushed.
 *
 * All or nothing: when a move fails part-way (the repository will not move
 * after its worktrees did), the worktrees already moved are put back where
 * they were, so a retry finds them with their repository and moves them
 * together. A repository whose presence cannot be read (a permission or I/O
 * error, not an absence) stops the call before anything moves.
 *
 * A worktree is found by its `.git` FILE naming a folder inside the
 * repository — whether or not that folder is still there — so a worktree
 * git had already lost track of goes with the rest. Under the repository
 * reservation: no fetch or worktree add runs while the folders move.
 * Answers the workspace ids moved.
 *
 * `stillApplies`, when given, is asked again UNDER the reservation, before
 * anything moves: a caller decided to set the repository aside on what it
 * read before taking the reservation, and another caller may have set it
 * aside and made a fresh one of the configured address meanwhile. When the
 * answer is no, nothing moves and the call answers no ids.
 *
 * A workspaces root, or a working copy's `.git`, that cannot be read (a
 * permission or I/O error, not an absence) stops the call before anything
 * moves, as an unreadable repository does: moving the repository without
 * worktrees it could not see would leave every one of them pointing at
 * nothing.
 */
export async function setAsideRepository(
  repository: IKbRepository,
  workspacesRoot: string,
  kbDirName: string,
  dest: string,
  stillApplies?: () => Promise<boolean>,
): Promise<string[]> {
  return repository.mutex.runRepository(async () => {
    if (stillApplies && !(await stillApplies())) return [];
    const repositoryPath = await comparablePath(repository.dir);
    const inside = async (p: string): Promise<boolean> => {
      const at = await comparablePath(p);
      return at === repositoryPath || at.startsWith(repositoryPath + path.sep);
    };
    const worktrees: Array<{ id: string; dir: string }> = [];
    let entries: import('node:fs').Dirent[] = [];
    try {
      entries = await fs.readdir(workspacesRoot, { withFileTypes: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // No workspaces root: only the repository to move.
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(workspacesRoot, entry.name, kbDirName);
      // Only absence shows a folder is no worktree: a `.git` that could not be
      // read (EACCES, EIO) stops the call, as an unreadable root does.
      const gitdir = await readGitfile(path.join(dir, '.git'));
      if (gitdir !== null && (await inside(gitdir))) worktrees.push({ id: entry.name, dir });
    }
    const repositoryThere = await fs.access(repository.dir).then(
      () => true,
      (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return false;
        throw err;
      },
    );
    if (!repositoryThere && worktrees.length === 0) return [];
    const moved: Array<{ dir: string; to: string }> = [];
    const movedRepository = path.join(dest, path.basename(repository.dir));
    try {
      for (const { id, dir } of worktrees) {
        const to = path.join(dest, id);
        await setAsideClone(dir, to);
        moved.push({ dir, to });
      }
      if (repositoryThere) await setAsideClone(repository.dir, movedRepository);
    } catch (err) {
      // Back where they were, beside the repository that did not move.
      for (const { dir, to } of moved.reverse()) {
        await setAsideClone(to, dir).catch((backErr: unknown) => {
          log.error(`the set-aside worktree ${to} could not be put back at ${dir}; it is kept there:`, {
            detail: backErr instanceof Error ? backErr.message : String(backErr),
          });
        });
      }
      throw err;
    }
    if (repositoryThere) {
      await repository.relinkMovedCopy(movedRepository, moved.map(({ to }) => to));
    }
    repository.forget();
    return worktrees.map(({ id }) => id);
  });
}
