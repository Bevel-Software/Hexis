/**
 * Which pages this browser's viewer allowed to write: the SHA-256 digests of
 * the pages' sources, newest last. A page whose source hashes to one of them
 * asks nothing; any change to its source is a digest not here, and asks once
 * more. Kept per browser and deployment, like the frame's height, and never
 * a deny: Don't allow stores nothing.
 *
 * A browser that cannot store or read them is asked on every view, as it
 * would be with nothing remembered, and is told nothing about it.
 */
export const ALLOWED_PAGES_KEY = 'bevel.htmlPage.allowedWrites';

/** How many digests are kept: past it, the least recently allowed is forgotten. */
export const ALLOWED_PAGES_MAX = 500;

function allowedDigests(): string[] {
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(ALLOWED_PAGES_KEY) ?? '[]');
    return Array.isArray(stored) ? stored.filter((d): d is string => typeof d === 'string') : [];
  } catch {
    return [];
  }
}

/** Whether the viewer allowed a page with this digest in this browser. */
export function isRemembered(digest: string): boolean {
  return allowedDigests().includes(digest);
}

/** Remember an Allow for this digest, as the most recent one. */
export function remember(digest: string): void {
  const kept = allowedDigests().filter((d) => d !== digest);
  kept.push(digest);
  try {
    window.localStorage.setItem(ALLOWED_PAGES_KEY, JSON.stringify(kept.slice(-ALLOWED_PAGES_MAX)));
  } catch {
    // Not stored: the card shows on the next view, which is no worse than before.
  }
}
