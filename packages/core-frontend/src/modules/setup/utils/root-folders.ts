import { AGENTS_DIR, DATA_DIR, PIPELINES_DIR, validateKbRootName } from '@bevel-software/platform-shared';

/**
 * What the repository holds for one configured root folder, judged against
 * the top-level folder names the connection test listed.
 *
 *  - `found`: a folder with exactly that name.
 *  - `missing`: nothing like it; the initialization phase will create it.
 *  - `variant`: no exact match, but a folder that is plainly the same one
 *    spelled differently — by case (`skills` for `Skills`), by a trailing `s`
 *    (`Skill`), or by both (`skill`). Exactly the repository that got an empty
 *    `Skills/` scaffolded beside its real `skills/` and imported nothing.
 */
export type RootFolderState =
  | { kind: 'found' }
  | { kind: 'missing' }
  | { kind: 'variant'; candidate: string; difference: 'case' | 'trailing-s' | 'case-and-trailing-s' };

const withoutTrailingS = (name: string) => name.replace(/s$/i, '');

export function rootFolderState(configured: string, rootFolders: readonly string[]): RootFolderState {
  const name = configured.trim();
  if (rootFolders.includes(name)) return { kind: 'found' };
  const byCase = rootFolders.find((folder) => folder.toLowerCase() === name.toLowerCase());
  if (byCase) return { kind: 'variant', candidate: byCase, difference: 'case' };
  const byPlural = rootFolders.find(
    (folder) => withoutTrailingS(folder).toLowerCase() === withoutTrailingS(name).toLowerCase(),
  );
  if (!byPlural) return { kind: 'missing' };
  return {
    kind: 'variant',
    candidate: byPlural,
    difference: withoutTrailingS(byPlural) === withoutTrailingS(name) ? 'trailing-s' : 'case-and-trailing-s',
  };
}

const RESERVED_ROOTS = [DATA_DIR, AGENTS_DIR, PIPELINES_DIR].map((name) => name.toLowerCase());

/**
 * Whether a listed folder may be offered as a root name: one the save would
 * accept on its own — not `.github`, not a reserved root like `Data`. Taking a
 * suggestion should never produce a validation error.
 */
export function isRootFolderSuggestion(name: string): boolean {
  return !validateKbRootName(name) && !RESERVED_ROOTS.includes(name.trim().toLowerCase());
}
