/**
 * How a list of conflicting files is stated: the first few by name, the rest
 * as a count. One rule, so the sync-conflict sentence the server writes and
 * the change-request dialog's banner name the same number of files and say
 * the rest in the same words, however many there are.
 */

/** How many conflicting files are named before "and N more". */
export const CONFLICT_FILES_NAMED = 3;

/** The files to name, in the order given, and how many are left for "and N more". */
export function namedConflictFiles<T>(files: readonly T[]): { named: T[]; more: number } {
  const named = files.slice(0, CONFLICT_FILES_NAMED);
  return { named, more: files.length - named.length };
}

/** The words for the files left out: "and 1 more file", "and 5 more files". */
export function moreConflictFiles(more: number): string {
  return `and ${more} more file${more === 1 ? '' : 's'}`;
}
