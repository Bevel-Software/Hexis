/**
 * ONE canonical identity for a workspace file, plus the refusals the file
 * verbs already answer with, as a single throwing call.
 *
 * `canonicalRelativePath` (in `@bevel-software/platform-shared`) collapses the
 * spellings of one file: `x/a.md`, `./x/a.md` and `x//a.md` are the same file
 * and all three become `x/a.md`. What it deliberately does NOT do is launder:
 * a path it cannot canonicalise comes back UNCHANGED, so every gate downstream
 * still sees what the caller actually sent. That leaves the caller holding an
 * un-refused path, which is fine for `PUT /file` (the workspace service's own
 * guards run right after) and wrong for anything that coordinates on the path
 * WITHOUT ever touching disk. The file-lock service is exactly that: nothing
 * below it resolves the path against a workspace directory, so a spelling that
 * escapes or launders would quietly become a lock row of its own.
 *
 * This helper is therefore the canonicaliser AND the refusal, in the order the
 * file verbs run them, so both surfaces answer the same thing for the same
 * input:
 *
 *   1. `validateRelativePath` refuses `.` and `..` segments, backslashes and
 *      an empty path. Repeated slashes it does NOT refuse: `x//a.md` is a
 *      spelling of `x/a.md`, and the canonicaliser has already collapsed it by
 *      the time the validator runs. `WorkspaceService.withPathTurn` runs the
 *      same check first (via the shared `assertValidRelativePath`) and its
 *      `Invalid path: ...` message is what `workspace.routes.sendError` turns
 *      into a 400. Same message here, raised as a 400 `WorkflowValidationError`.
 *   2. Containment. `withPathTurn` then resolves the path against the
 *      workspace directory and refuses anything landing outside it, which
 *      `sendError` turns into a 403. Step 1 has already rejected every `..`,
 *      so the only spelling that can still escape is an absolute one, and
 *      that is the whole of what this step refuses. It is refused AS absolute
 *      rather than by resolving it against a stand-in root: `/workspace/a.md`
 *      would resolve to inside any stand-in named `/workspace` and read as
 *      contained, while the real workspace directory is `<workspacesRoot>/<id>`
 *      and never literally `/workspace`, so the file verbs resolve that same
 *      path outside their workspace and answer 403. With `..` gone and
 *      absolute refused, every remaining spelling is relative and cannot
 *      leave whatever directory it is resolved against — there is nothing
 *      left for a resolve-and-compare to decide, so there is none here.
 *
 * Case is left alone, for the reason `canonicalRelativePath` documents: the
 * deployment target is Linux, where `Foo.md` and `foo.md` are two files.
 *
 * What this deliberately does NOT answer is whether the path reaches its file
 * through a symbolic link. That question is about what is on disk, not about
 * how the path is spelled, and it is answered where the disk is:
 * `WorkspaceService.assertNotThroughLink`, on the verbs that read and write
 * bytes. A lock row is a coordination key and the lock service holds no
 * workspace directory to resolve against, so a link can only change which
 * bytes a WRITE touches, and that write is refused by the verb that performs
 * it while the lock is merely held.
 */

import { canonicalRelativePath, validateRelativePath } from '@bevel-software/platform-shared';
import { PathTraversalError, WorkflowValidationError } from './domain-errors.js';

/**
 * The canonical spelling of `targetPath`, or a throw carrying the status the
 * file verbs answer with for that same input.
 *
 * @throws {WorkflowValidationError} 400, when the path is not a usable
 *   workspace-relative path (not a string at all, a `.` or `..` segment, a
 *   backslash, empty).
 * @throws {PathTraversalError} 403, when the path resolves outside the
 *   workspace (an absolute path).
 */
export function canonicalFileIdentity(targetPath: string): string {
  // A JSON body can hold anything and the lock routes' own guard only tests
  // falsiness, so a truthy non-string (`{"path": 123}`) arrives here. The
  // canonicaliser calls `.startsWith` on it and throws a bare `TypeError`,
  // which `toHttpError` can only read as a 500 — for what is a client
  // mistake. `PUT /file` answers 400 for that same body (its `requestPath`
  // type-guards before canonicalising), and this surface answers what that one
  // answers. The message is the validator's own for a non-string, so the two
  // 400s read identically as well.
  if (typeof targetPath !== 'string') {
    throw new WorkflowValidationError('Invalid path: Path is required');
  }
  const canonical = canonicalRelativePath(targetPath);
  const reason = validateRelativePath(canonical);
  if (reason) throw new WorkflowValidationError(`Invalid path: ${reason}`);
  // `validateRelativePath` ACCEPTS `/workspace/a.md` (its leading empty
  // segment is filtered out, leaving two ordinary segments), so absolute is
  // refused here, on its own terms: a workspace-relative path is never
  // absolute, and the file verbs treat one as the escape it is. This is the
  // only containment refusal there is — see step 2 in the header for why a
  // resolve-and-compare against a stand-in root would decide nothing more.
  if (canonical.startsWith('/')) {
    throw new PathTraversalError();
  }
  return canonical;
}
