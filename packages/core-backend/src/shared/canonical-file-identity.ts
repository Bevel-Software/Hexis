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
 *   1. `validateRelativePath` refuses `.`/`..`/empty segments and backslashes.
 *      `WorkspaceService.withPathTurn` runs the same check first (via the
 *      shared `assertValidRelativePath`) and its `Invalid path: ...` message
 *      is what `workspace.routes.sendError` turns into a 400. Same message
 *      here, raised as a 400 `WorkflowValidationError`.
 *   2. Containment. `withPathTurn` then resolves the path against the
 *      workspace directory and refuses anything landing outside it, which
 *      `sendError` turns into a 403. Step 1 has already rejected every `..`,
 *      so the only spelling that can still escape is an absolute one — and an
 *      absolute path is refused AS one, before any stand-in root is resolved
 *      against, because a stand-in cannot decide it: `/workspace/a.md`
 *      resolves to INSIDE the stand-in and would read as contained, while the
 *      real workspace directory is `<workspacesRoot>/<id>` and never
 *      literally `/workspace`, so the file verbs resolve that same path
 *      outside their workspace and answer 403. Left to the stand-in are only
 *      the relative spellings, which it decides without a real workspace on
 *      disk.
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

import path from 'node:path';
import { canonicalRelativePath, validateRelativePath } from '@bevel-software/platform-shared';
import { PathTraversalError, WorkflowValidationError } from './domain-errors.js';

/**
 * Stand-in for the workspace directory, deciding containment for the RELATIVE
 * spellings only. Their verdict is the same under any absolute root, which is
 * what lets a stand-in stand in at all. An absolute spelling is NOT its
 * business — under this root `/workspace/a.md` looks contained and under any
 * other root it does not — so that one is refused before we get here. POSIX
 * resolution because workspace paths are `/`-separated on every platform we
 * run on.
 */
const CONTAINMENT_ROOT = '/workspace';

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
  // Absolute first, and on its own terms: `validateRelativePath` ACCEPTS
  // `/workspace/a.md` (its leading empty segment is filtered out, leaving two
  // ordinary segments), and resolving that against CONTAINMENT_ROOT lands it
  // inside the root, so the containment check below would call it contained.
  // A workspace-relative path is never absolute; refuse it as the escape the
  // file verbs treat it as.
  if (path.posix.isAbsolute(canonical)) {
    throw new PathTraversalError();
  }
  const resolved = path.posix.resolve(CONTAINMENT_ROOT, canonical);
  if (resolved !== CONTAINMENT_ROOT && !resolved.startsWith(`${CONTAINMENT_ROOT}/`)) {
    throw new PathTraversalError();
  }
  return canonical;
}
