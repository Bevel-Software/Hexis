import fs from 'node:fs/promises';
import path from 'node:path';
import { isAbsence } from '../../shared/fs.contract.js';

/**
 * Where a checkout's git directory is, read from its `.git` without spawning
 * git — the one resolver every reader of a worktree's own files uses.
 *
 * A full clone's `.git` is the git directory itself. A worktree's `.git` is a
 * FILE (`gitdir: <path>`) naming its folder in the repository, resolved
 * against the file's own folder as git does.
 */

/**
 * The folder a gitfile (`gitdir: <path>`) names; null when the file is absent,
 * is a folder, or says nothing of the kind. Any other read error propagates:
 * a `.git` that could not be read has not been shown to be anything.
 */
export async function readGitfile(gitfile: string): Promise<string | null> {
  let text: string;
  try {
    text = await fs.readFile(gitfile, 'utf-8');
  } catch (err) {
    if (isAbsence(err) || (err as NodeJS.ErrnoException).code === 'EISDIR') return null;
    throw err;
  }
  // Exactly what git reads (setup.c, `read_gitfile_gently`): the whole file
  // is `gitdir: ` and a path, with nothing after the path but line ends. A
  // second line, other spacing before the path, or anything after it is no
  // gitfile to git, so it names no folder here either.
  const m = /^gitdir: ([^\r\n]+?)[\r\n]*$/.exec(text);
  if (!m) return null;
  return path.resolve(path.dirname(gitfile), m[1]!);
}

/**
 * The git directory of the checkout at `checkoutDir`: its `.git` folder, or
 * the folder its `.git` file names. Null when there is no `.git`, or a `.git`
 * file that names no folder. Errors other than absence propagate.
 */
export async function gitDirOf(checkoutDir: string): Promise<string | null> {
  const dotGit = path.join(checkoutDir, '.git');
  let stat;
  try {
    stat = await fs.stat(dotGit);
  } catch (err) {
    if (isAbsence(err)) return null;
    throw err;
  }
  if (stat.isDirectory()) return dotGit;
  if (!stat.isFile()) return null;
  return readGitfile(dotGit);
}
