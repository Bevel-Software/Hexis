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

/** True when `wsPath` is the repository folder or lies under it. */
export function isInsideRepo(wsPath: string, kbDirName: string): boolean {
  return wsPath === kbDirName || wsPath.startsWith(`${kbDirName}/`);
}

/**
 * Refuse a workspace-relative path that would land outside the repository.
 * The message carries the corrected path so an agent can retry without
 * guessing; the payload carries a typed discriminator for callers that
 * switch on it.
 */
export function assertInsideRepo(wsPath: string, kbDirName: string): void {
  if (isInsideRepo(wsPath, kbDirName)) return;
  const stripped = wsPath.replace(/^(\.\/|\/)+/, '');
  const corrected = isInsideRepo(stripped, kbDirName) ? stripped : `${kbDirName}/${stripped}`;
  throw new WorkflowValidationError(
    `"${wsPath}" is outside the knowledge base repository: paths are workspace-relative and must start with "${kbDirName}/". ` +
      `Use "${corrected}" instead. A file written without that prefix lands beside the repository, where it is never committed or pushed.`,
    { kind: 'path-outside-repo', path: wsPath, kbDirName },
  );
}
