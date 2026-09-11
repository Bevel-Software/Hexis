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
 *      so the only spelling that can still escape is an absolute one, and
 *      resolving against a stand-in root decides it without needing a real
 *      workspace on disk.
 *
 * Case is left alone, for the reason `canonicalRelativePath` documents: the
 * deployment target is Linux, where `Foo.md` and `foo.md` are two files.
 */

import path from 'node:path';
import { canonicalRelativePath, validateRelativePath } from '@bevel-software/platform-shared';
import { PathTraversalError, WorkflowValidationError } from './domain-errors.js';

/**
 * Stand-in for the workspace directory. Only the containment VERDICT matters
 * here, and that verdict is the same under any absolute root: a relative path
 * stays under it, an absolute one wins over it. POSIX resolution because
 * workspace paths are `/`-separated on every platform we run on.
 */
const CONTAINMENT_ROOT = '/workspace';

/**
 * The canonical spelling of `targetPath`, or a throw carrying the status the
 * file verbs answer with for that same input.
 *
 * @throws {WorkflowValidationError} 400, when the path is not a usable
 *   workspace-relative path (a `.` or `..` segment, a backslash, empty).
 * @throws {PathTraversalError} 403, when the path resolves outside the
 *   workspace (an absolute path).
 */
export function canonicalFileIdentity(targetPath: string): string {
  const canonical = canonicalRelativePath(targetPath);
  const reason = validateRelativePath(canonical);
  if (reason) throw new WorkflowValidationError(`Invalid path: ${reason}`);
  const resolved = path.posix.resolve(CONTAINMENT_ROOT, canonical);
  if (resolved !== CONTAINMENT_ROOT && !resolved.startsWith(`${CONTAINMENT_ROOT}/`)) {
    throw new PathTraversalError();
  }
  return canonical;
}
