/**
 * The empty-folder placeholder. Git tracks files, not folders, so a folder
 * with nothing in it is kept alive by one empty file. That file is how a
 * folder survives a clone and nothing more: it is never content, so every
 * listing, tree, stat, search and change-request view hides it.
 *
 * The rule it serves: a folder exists until someone deletes it explicitly.
 * Creating one (UI, `mkdir`, a nested write) and emptying one (deleting or
 * moving out its last file) both leave a folder that lists as a folder; only
 * an explicit folder delete removes it, placeholder included.
 */
export const FOLDER_PLACEHOLDER = '.gitkeep';

/** True when `nameOrPath` (a bare name or any `/`-separated path) is the placeholder. */
export function isFolderPlaceholder(nameOrPath: string): boolean {
  const slash = nameOrPath.lastIndexOf('/');
  return (slash === -1 ? nameOrPath : nameOrPath.slice(slash + 1)) === FOLDER_PLACEHOLDER;
}

/** The placeholder's path inside `dir` (`''` for a root-level placeholder). */
export function folderPlaceholderPath(dir: string): string {
  const trimmed = dir.replace(/\/+$/, '');
  return trimmed ? `${trimmed}/${FOLDER_PLACEHOLDER}` : FOLDER_PLACEHOLDER;
}
