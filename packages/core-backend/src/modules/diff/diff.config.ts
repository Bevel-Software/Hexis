/**
 * File extensions that participate in diff review.
 * Only these extensions get backup copies under <backupsRoot>/<userId>/...
 * and surface in the pending-changes list.
 */
export const DIFFABLE_EXTENSIONS: ReadonlySet<string> = new Set(['.md']);

export function isDiffable(filePath: string): boolean {
  const dot = filePath.lastIndexOf('.');
  if (dot < 0) return false;
  return DIFFABLE_EXTENSIONS.has(filePath.slice(dot).toLowerCase());
}
