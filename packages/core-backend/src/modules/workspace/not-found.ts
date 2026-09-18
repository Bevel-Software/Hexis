import { ToolError } from '../tool-helpers/tool.contract.js';
import { isAbsence } from '../../shared/fs.contract.js';
import { PathNotFoundError } from '../../shared/domain-errors.js';
import { sanitizedPath } from '../../shared/printable.js';
import { logger } from '../../shared/logging.js';

const log = logger('not-found');

/**
 * ONE answer for "there is nothing at that path", for every file tool.
 *
 * A path that is not there is an ordinary answer, not a failure of the server:
 * the caller spelled a name nothing holds, and the fix is theirs. Each tool
 * used to reach that conclusion its own way — some with a 404, most by letting
 * the filesystem's own `ENOENT` escape as a 500 — so an agent could not tell
 * "your path is wrong" from "this deployment is broken", and had no stable
 * field to branch on either way.
 *
 * So the mapping lives here and nowhere else. Every tool wraps the call that
 * can meet absence in {@link orNotFound}, and every one of them then answers:
 *
 *   - **404**, because the path is the caller's to correct;
 *   - `kind: 'not_found'`, the stable discriminator beside the prose (the same
 *     `kind` convention `write-denied` and `git-internals` already use);
 *   - the REQUESTED path, sanitized — echoed back so a chained caller can see
 *     which of its arguments was wrong, never the path on disk;
 *   - one sentence of next steps, always the same one.
 *
 * What is NOT absence stays a 500. ENOENT and ENOTDIR are the disk's own
 * definition of "nothing is there" ({@link isAbsence}); a permission error, an
 * I/O error or a symlink loop means the path could not be READ, and answering
 * those 404 would tell a caller to go and fix a name that is perfectly fine
 * while an outage went unreported. Their raw code goes to the operator log —
 * the caller gets the 500 it has always got.
 *
 * ORDER MATTERS: a tool that gates reads must let the gate answer FIRST. A 404
 * on a path the caller may not read would confirm the path is absent, and the
 * absence of a name is as much a disclosure as its presence. Every read tool
 * here calls `assertCanRead` before it touches the disk, and this helper is
 * only ever reached past that point.
 */

/** The next step, in one sentence — identical on every tool, so it is written once. */
export const NOT_FOUND_NEXT_STEP = 'Check the path with list_files.';

/** The machine-readable body of a missing-path refusal. */
export interface NotFoundDetails {
  kind: 'not_found';
  /** The path the caller asked for, sanitized for a one-line message. */
  path: string;
}

/**
 * The 404 every file tool answers for a path that is not there.
 *
 * `lead` replaces the default opening clause for a tool whose missing path is
 * not simply "the file you named" — grep's search root, a move's source — so
 * the caller learns WHICH argument was wrong. The path, the `kind` and the
 * next step never vary.
 */
export function notFound(path: string, lead?: string): ToolError {
  const safe = sanitizedPath(path);
  const details: NotFoundDetails = { kind: 'not_found', path: safe };
  const opening = lead === undefined
    ? `There is no file or directory at "${safe}" in this workspace.`
    : `${lead}: there is no file or directory at "${safe}" in this workspace.`;
  return new ToolError(`${opening} ${NOT_FOUND_NEXT_STEP}`, 404, { ...details });
}

/**
 * Run `work`, and answer {@link notFound} if it turns out `path` is not there.
 *
 * Absence arrives in two shapes and both are absence: a filesystem error
 * carrying `ENOENT`/`ENOTDIR` (raw Node errors and Mastra's `FileNotFoundError`
 * alike), and a {@link PathNotFoundError} a service raised because it probed
 * the path itself. Anything else is rethrown untouched, with its raw code
 * logged for the operator and nothing new added to what the caller sees.
 */
export async function orNotFound<T>(path: string, work: () => Promise<T>, lead?: string): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof PathNotFoundError) throw notFound(err.path, lead);
    if (isAbsence(err)) throw notFound(path, lead);
    // Not absence: the path could not be READ, which is a 500 and an operator's
    // problem. The raw errno is logged here — the one place that saw it — and
    // the error travels on unchanged.
    const code = (err as { code?: unknown } | null)?.code;
    if (typeof code === 'string') {
      log.error('filesystem failure that is not absence:', { code, path: sanitizedPath(path) });
    }
    throw err;
  }
}

/**
 * {@link orNotFound} for work that probes the path ITSELF and says so with a
 * {@link PathNotFoundError} — unzip's service, which must open the archive to
 * answer at all.
 *
 * Only that declared answer maps. A raw `ENOENT` from deep inside such work is
 * NOT the named path being absent: an extraction that fails part-way through
 * is a failure of the extraction, and calling it "your .zip is not there"
 * would send the caller to re-spell a path that was never wrong.
 */
export async function orDeclaredNotFound<T>(work: () => Promise<T>, lead?: string): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof PathNotFoundError) throw notFound(err.path, lead);
    throw err;
  }
}
