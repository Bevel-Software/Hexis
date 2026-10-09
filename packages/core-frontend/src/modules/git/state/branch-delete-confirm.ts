/**
 * "Don't ask again" for deleting a shared branch: remembered in this browser,
 * for the person who ticked it, until they turn the question back on from the
 * profile menu.
 *
 * Keyed by email — the admin page's "last seen" marker does the same — so a
 * colleague signing in on the same browser is still asked. Every read and
 * write is guarded: a browser that refuses storage (strict privacy mode, a
 * full quota) reads as "ask", so the question can never be skipped by
 * accident, only by the person's own tick.
 */
const KEY_PREFIX = 'hexis.skipBranchDeleteConfirm:';

function keyFor(email: string): string {
  return KEY_PREFIX + email.trim().toLowerCase();
}

/** Whether this person turned the branch-delete question off in this browser. */
export function isBranchDeleteConfirmSkipped(email: string | null | undefined): boolean {
  if (!email) return false;
  try {
    return localStorage.getItem(keyFor(email)) === '1';
  } catch {
    return false;
  }
}

/** Stop asking this person. A browser that cannot store it keeps asking. */
export function skipBranchDeleteConfirm(email: string | null | undefined): void {
  if (!email) return;
  try {
    localStorage.setItem(keyFor(email), '1');
  } catch {
    // Nothing stored, so the next delete asks — the safe side.
  }
}

/** Ask this person again before every shared-branch delete. */
export function askBeforeBranchDelete(email: string | null | undefined): void {
  if (!email) return;
  try {
    localStorage.removeItem(keyFor(email));
  } catch {
    // Unreadable storage already reads as "ask".
  }
}
