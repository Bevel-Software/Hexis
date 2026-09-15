import type { FileTreeEntry } from '@bevel-software/platform-shared';

/** The file tree's own root row — the whole KB, not a folder inside it. */
const TREE_ROOT_PATH = '.';

/**
 * Whether an entry offers `Manage access` at all — the explorer's right-click
 * rule, stated once so every other surface that opens the dialog on a folder
 * (the skill page's Share) follows the same condition instead of restating it.
 *
 * This is the AFFORDANCE, not the permission: the dialog resolves the caller's
 * verdict itself and renders read-only for anyone who cannot write the rules,
 * and the grant route enforces it again server-side.
 */
export function offersManageAccess(entry: Pick<FileTreeEntry, 'relativePath'>): boolean {
  return entry.relativePath !== TREE_ROOT_PATH;
}
