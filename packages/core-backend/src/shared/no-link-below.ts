import path from 'node:path';
import { lstatOrNull } from './rename-no-replace.js';

/**
 * The first folder between `base` (exclusive) and `absolute` (inclusive)
 * that is a symbolic link, or null when none is — judged by `lstat` on each
 * ancestor, so a path that would be followed out of `base` is named before
 * anything reads or writes through it. ONE rule for every sink that resolves
 * a repository path on disk: the locking filesystem's moves and the merge's
 * conflict reads and writes.
 */
export async function linkedAncestor(base: string, absolute: string): Promise<string | null> {
  const root = path.resolve(base);
  // Below `root` means past a separator after it: `/tmp/repository` is a
  // sibling of `/tmp/repo`, not inside it, and is never walked or stat'ed. A
  // filesystem root already ends with its separator.
  const inside = root.endsWith(path.sep) ? root : root + path.sep;
  let current = path.resolve(absolute);
  const ancestors: string[] = [];
  while (current.startsWith(inside)) {
    ancestors.push(current);
    current = path.dirname(current);
  }
  for (const ancestor of ancestors) {
    const stat = await lstatOrNull(ancestor);
    if (stat?.isSymbolicLink()) return ancestor;
  }
  return null;
}
