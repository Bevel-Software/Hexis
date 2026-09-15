import path from 'node:path';
import { PathTraversalError } from './domain-errors.js';

/**
 * THE containment check for ABSOLUTE paths: is `absolutePath` the directory
 * `dir`, or something under it?
 *
 * Three surfaces carried a copy of this — the workspace service, the diff
 * ledger and the delete route — and each threw a bare `Error` whose MESSAGE
 * five catch sites then matched to decide on a 403. A reworded message would
 * have turned every one of those into a 500, which is to say into a silently
 * unblocked traversal in the log. So the refusal is a TYPE now
 * ({@link PathTraversalError}, 403 with a `path-traversal` payload), and the
 * route layers read the status off the class like every other domain error.
 *
 * LEXICAL, deliberately: it compares resolved spellings and follows no links,
 * so it is safe to call before anything touches the disk. It is therefore not
 * the whole rule — a path may be contained by its spelling and still reach
 * outside through a symlink, which is `assertNotThroughLink`'s job, and a
 * workspace-RELATIVE spelling is `canonicalFileIdentity`'s. This is the first
 * of those three, and the only one every caller needs.
 */
export function assertWithinDirectory(absolutePath: string, dir: string): void {
  const resolved = path.resolve(absolutePath);
  const root = path.resolve(dir);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new PathTraversalError();
  }
}
