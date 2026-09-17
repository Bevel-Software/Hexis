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

/** Percent-decode until the spelling stops changing (`%252e` is `.` twice removed). */
function percentDecoded(value: string): string {
  let current = value;
  for (let i = 0; i < 8; i++) {
    const next = current.replace(/%([0-9a-f]{2})/gi, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    if (next === current) break;
    current = next;
  }
  return current;
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

/** `realpath` of the deepest existing ancestor of `absolutePath`, with the missing rest joined back on. */
async function resolvedRealPath(absolutePath: string): Promise<string | null> {
  let existing = absolutePath;
  const rest: string[] = [];
  for (;;) {
    const real = await fs.realpath(existing).catch((err: unknown) => {
      if (isAbsence(err) || (err as { code?: unknown })?.code === 'ELOOP') return null;
      throw err;
    });
    if (real !== null) return path.join(real, ...rest);
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
  const target = absolutePath ?? path.resolve(rootDir, inputPath.replace(/^[\\/]+/, ''));
  if (hasGitInternalsSegment(path.relative(path.resolve(rootDir), target))) throw new GitInternalsError();
  const [realTarget, realRoot] = await Promise.all([resolvedRealPath(target), resolvedRealPath(path.resolve(rootDir))]);
  if (realTarget === null || realRoot === null) return;
  if (hasGitInternalsSegment(path.relative(realRoot, realTarget))) throw new GitInternalsError();
}
