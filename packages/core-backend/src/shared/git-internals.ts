import fs from 'node:fs/promises';
import path from 'node:path';
import { GitInternalsError } from './domain-errors.js';
import { isAbsence } from './fs.contract.js';

/**
 * The repository's internal git folder is never a workspace path.
 *
 * `.git/` holds the object database, the refs and the clone's config — the
 * credential helper among it. No file tool and no workspace route reads,
 * lists, writes or moves anything there; git itself is the only writer. The
 * rule is judged on segments, never on a prefix, so `.github/` and
 * `.gitkeep` stay ordinary paths.
 *
 * Two checks, both needed:
 *   - {@link hasGitInternalsSegment} is LEXICAL: any spelling that names the
 *     folder — `.GIT`, `%2egit`, `a/../.git`, `a\.git` — is refused before
 *     anything touches the disk, so a refusal takes no lock and records no
 *     read.
 *   - {@link assertNotGitInternals} adds the RESOLVED form: the deepest part
 *     of the path that exists is run through `realpath`, so a symbolic link
 *     in the repository that points into the folder is refused the same way.
 */

/**
 * Percent-decode until the spelling stops changing (`%252e` is `.` twice
 * removed), however many layers deep. No pass limit is needed: a pass that
 * changes anything makes the string shorter, so the loop always ends.
 */
function percentDecoded(value: string): string {
  let current = value;
  for (;;) {
    const next = current.replace(/%([0-9a-f]{2})/gi, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    if (next === current) return current;
    current = next;
  }
}

/**
 * Whether one path segment names the git folder. Case-folded, because a
 * case-insensitive volume opens `.GIT` as `.git`; trailing dots and spaces
 * dropped, because Windows does the same to `.git.` and `.git `.
 */
function isGitSegment(segment: string): boolean {
  return segment.replace(/[. ]+$/, '').toLowerCase() === '.git';
}

/** True when any segment of `inputPath`, in any spelling, is the git folder. */
export function hasGitInternalsSegment(inputPath: unknown): boolean {
  if (typeof inputPath !== 'string') return false;
  return percentDecoded(inputPath)
    .split(/[\\/]+/)
    .some(isGitSegment);
}

/** Refuse `inputPath` lexically. See {@link hasGitInternalsSegment}. */
export function assertNoGitInternalsSegment(inputPath: unknown): void {
  if (hasGitInternalsSegment(inputPath)) throw new GitInternalsError();
}

const errCode = (err: unknown): unknown => (err as { code?: unknown })?.code;

/** `null` for "nothing resolvable here" (absent, or a link loop); every other filesystem error is rethrown. */
function nullWhenUnresolvable(err: unknown): null {
  if (isAbsence(err) || errCode(err) === 'ELOOP') return null;
  throw err;
}

/** Dangling links followed by hand before the chain counts as a loop (Linux's own limit). */
const MAX_LINK_HOPS = 40;

/**
 * `realpath` of the deepest existing ancestor of `absolutePath`, with the
 * missing rest joined back on. A DANGLING link on the way is followed by hand:
 * `realpath` refuses it, but a write through it lands at its target, so the
 * target is what gets judged (`notes.md -> .git/hooks/post-checkout`).
 */
async function resolvedRealPath(absolutePath: string): Promise<string | null> {
  let existing = absolutePath;
  const rest: string[] = [];
  let hops = 0;
  for (;;) {
    const real = await fs.realpath(existing).catch(nullWhenUnresolvable);
    if (real !== null) return path.join(real, ...rest);
    // EINVAL is "not a link": nothing to follow. Any other failure — a
    // permission error, say — is thrown, never guessed past lexically.
    const target =
      hops < MAX_LINK_HOPS
        ? await fs.readlink(existing).catch((err: unknown) => (errCode(err) === 'EINVAL' ? null : nullWhenUnresolvable(err)))
        : null;
    if (target !== null) {
      const parent = await fs.realpath(path.dirname(existing)).catch(nullWhenUnresolvable);
      if (parent !== null) {
        hops++;
        existing = path.resolve(parent, target);
        continue;
      }
    }
    const up = path.dirname(existing);
    if (up === existing) return null;
    rest.unshift(path.basename(existing));
    existing = up;
  }
}

/**
 * Refuse a path under `rootDir` that names the git folder or resolves into it.
 *
 * `inputPath` is the caller's own spelling (checked lexically, encoded forms
 * included); `absolutePath` is where it lands on disk. Only the part below
 * `rootDir` is judged, so a workspaces root that itself sits under some
 * `.git` directory does not refuse everything. A link that leaves the root
 * is judged on its target's path relative to the root, so a link into
 * another checkout's `.git` is refused too; whether such a link may be
 * followed at all is the containment checks' business.
 */
export async function assertNotGitInternals(rootDir: string, inputPath: string, absolutePath?: string): Promise<void> {
  assertNoGitInternalsSegment(inputPath);
  const root = path.resolve(rootDir);
  const realRoot = await resolvedRealPath(root);
  const resolved = absolutePath !== undefined;
  for (const target of resolved ? [absolutePath] : candidateTargets(root, inputPath)) {
    const relative = path.relative(root, target);
    if (hasGitInternalsSegment(relative)) throw new GitInternalsError();
    if (realRoot === null) continue;
    // A raw spelling fans out into candidates, and one of them can name a
    // place outside the workspace entirely — `/etc/…`, a deep climb. Such a
    // candidate is judged by the lexical reading above (a link into another
    // checkout's `.git` is named there) but NOT probed on disk: probing it
    // would let an unreadable external directory answer with its own
    // `EACCES` instead of the path rule's typed refusal for a spelling that
    // was never a workspace path. A path a layer already resolved is the one
    // place it is, so it is probed as given.
    // `..` and `../…` are the climbs; `..link` is an ordinary name that merely
    // starts with those characters, and a link by that name can point into the
    // folder — so it is probed like any other entry under the root.
    const climbsOut = relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
    if (!resolved && (relative === '' || climbsOut)) continue;
    const realTarget = await resolvedRealPath(target);
    if (realTarget !== null && hasGitInternalsSegment(path.relative(realRoot, realTarget))) throw new GitInternalsError();
  }
}

/**
 * Every place one raw spelling could LAND, because a spelling is not yet a
 * path until something decides how to read it.
 *
 * A backslash separates segments on Windows and is an ordinary character in a
 * filename here, so `kb\\Notes\\..\\link` is read BOTH ways; an absolute path
 * is both the path it names and — as every workspace caller reads it — that
 * path with its leading slashes dropped, under the workspace; and a leading
 * climb (`../kb/link`) is both the climb it spells and the path left when the
 * climb is dropped, which is how a lenient reader takes it. The spelling is
 * refused when ANY reading lands in the git folder: which reading a later
 * layer picks is not something this rule should have to predict.
 *
 * This is what a CALLER's own spelling needs. A path some layer has already
 * resolved arrives as `absolutePath` and is judged as the one place it is.
 */
function candidateTargets(root: string, inputPath: string): string[] {
  const targets = new Set<string>();
  for (const spelling of new Set([inputPath, inputPath.replace(/\\/g, '/')])) {
    const anchored = spelling.replace(/^[\\/]+/, '');
    targets.add(path.resolve(root, anchored));
    targets.add(path.resolve(root, anchored.replace(/^(\.\.?[\\/])+/, '')));
    if (/^[\\/]/.test(spelling)) targets.add(path.resolve(spelling));
  }
  return [...targets];
}
