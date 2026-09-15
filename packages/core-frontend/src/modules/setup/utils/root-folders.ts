/**
 * What the repository holds for one configured root folder, judged against
 * the top-level folder names the connection test listed.
 *
 *  - `found`: a folder with exactly that name.
 *  - `missing`: nothing like it; the initialization phase will create it.
 *  - `variant`: no exact match, but a folder that is plainly the same one
 *    spelled differently — only by case (`skills` for `Skills`), or by case and
 *    a trailing `s` (`skill`). Exactly the repository that got an empty
 *    `Skills/` scaffolded beside its real `skills/` and imported nothing.
 */
export type RootFolderState =
  | { kind: 'found' }
  | { kind: 'missing' }
  | { kind: 'variant'; candidate: string; caseOnly: boolean };

const withoutTrailingS = (name: string) => name.toLowerCase().replace(/s$/, '');

export function rootFolderState(configured: string, rootFolders: readonly string[]): RootFolderState {
  const name = configured.trim();
  if (rootFolders.includes(name)) return { kind: 'found' };
  const byCase = rootFolders.find((folder) => folder.toLowerCase() === name.toLowerCase());
  if (byCase) return { kind: 'variant', candidate: byCase, caseOnly: true };
  const byPlural = rootFolders.find((folder) => withoutTrailingS(folder) === withoutTrailingS(name));
  if (byPlural) return { kind: 'variant', candidate: byPlural, caseOnly: false };
  return { kind: 'missing' };
}
