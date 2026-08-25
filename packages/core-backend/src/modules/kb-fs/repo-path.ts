import path from 'node:path';
import { WorkflowValidationError } from '../../shared/domain-errors.js';

/**
 * Workspace-relative paths and the repository folder.
 *
 * A workspace directory holds the git clone as `<kbDirName>/` (plus transient
 * scratch such as `tmp/`). The agent filesystem, the lock keys and the human
 * editor all speak WORKSPACE-relative paths, so a path reaches git only when
 * it starts with that folder. `KnowledgeBase/Foo.md` on its own is not a
 * shorthand for `knowledge-base/KnowledgeBase/Foo.md`: it is a different
 * location, beside the clone, that nothing commits and nothing pushes.
 */

/**
 * True when `wsPath` is the repository folder or lies under it.
 *
 * Judged segment by segment, not by string prefix: `knowledge-base/../x.md`
 * starts with the folder yet resolves beside it, and the filesystem's own
 * containment is against the WORKSPACE dir, so it would accept that path.
 * `.` and `..` segments (and empty ones from `//`) are therefore refused
 * outright, and so is any backslash: on Windows it separates segments too,
 * so `foo\..\..` would climb the same way. Both match what the commit layer
 * accepts. A single trailing slash on a directory path is tolerated.
 */
export function isInsideRepo(wsPath: string, kbDirName: string): boolean {
  if (typeof wsPath !== 'string' || wsPath.includes('\\')) return false;
  const segments = wsPath.replace(/\/$/, '').split('/');
  if (segments[0] !== kbDirName) return false;
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/**
 * Refuse a workspace-relative path that would land outside the repository.
 * The message carries the corrected path so an agent can retry without
 * guessing; the payload carries a typed discriminator for callers that
 * switch on it.
 */
export function assertInsideRepo(wsPath: string, kbDirName: string): void {
  if (isInsideRepo(wsPath, kbDirName)) return;
  // The suggestion collapses what made the path wrong: backslashes, leading
  // `./` or `/`, and any `..` climbing back out (a bare `..` included, so the
  // suggestion is never itself a climb). The agent gets a path it can use.
  const normalized = path.posix
    .normalize(String(wsPath).replace(/\\/g, '/').replace(/^(\.\/|\/)+/, ''))
    .replace(/^(\.\.(\/|$))+/, '')
    .replace(/^\.$/, '');
  const corrected = isInsideRepo(normalized, kbDirName) ? normalized : `${kbDirName}/${normalized}`;
  throw new WorkflowValidationError(
    `"${wsPath}" is outside the knowledge base repository: paths are workspace-relative, must start with "${kbDirName}/" and may not contain "." or ".." segments or backslashes. ` +
      `Use "${corrected}" instead. A file written without that prefix lands beside the repository, where it is never committed or pushed.`,
    { kind: 'path-outside-repo', path: wsPath, kbDirName },
  );
}
