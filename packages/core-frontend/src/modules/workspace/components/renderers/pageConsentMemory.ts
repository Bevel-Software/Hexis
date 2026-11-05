/**
 * Which pages this browser's viewer allowed to write: the SHA-256 digests of
 * the pages' sources. A page whose source hashes to one of them asks nothing;
 * any change to its source is a digest not here, and asks once more. Kept per
 * browser and deployment, like the frame's height, and never a deny: Don't
 * allow stores nothing.
 *
 * Each digest is its own `localStorage` entry, `<prefix><digest>`, holding
 * when it was last allowed. An Allow writes only its own entry, so two tabs
 * allowing two pages at once cannot overwrite each other's; eviction past the
 * cap removes only the oldest entries.
 *
 * A browser that cannot store or read them is asked on every view, as it
 * would be with nothing remembered, and is told nothing about it.
 */
export const ALLOWED_PAGE_KEY_PREFIX = 'bevel.htmlPage.allowedWrite.';

/** How many digests are kept: past it, the least recently allowed is forgotten. */
export const ALLOWED_PAGES_MAX = 500;

interface Entry {
  digest: string;
  at: number;
}

/** Every remembered digest with when it was allowed, least recent first. */
function entries(storage: Storage): Entry[] {
  const found: Entry[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key === null || !key.startsWith(ALLOWED_PAGE_KEY_PREFIX)) continue;
    const at = Number(storage.getItem(key));
    if (!Number.isFinite(at)) continue;
    found.push({ digest: key.slice(ALLOWED_PAGE_KEY_PREFIX.length), at });
  }
  return found.sort((a, b) => a.at - b.at);
}

/** The digests this browser remembers an Allow for, least recently allowed first. */
export function rememberedDigests(): string[] {
  try {
    return entries(window.localStorage).map((e) => e.digest);
  } catch {
    return [];
  }
}

/** Whether the viewer allowed a page with this digest in this browser. */
export function isRemembered(digest: string): boolean {
  try {
    const at = window.localStorage.getItem(ALLOWED_PAGE_KEY_PREFIX + digest);
    return at !== null && Number.isFinite(Number(at));
  } catch {
    return false;
  }
}

/** Remember an Allow for this digest, as the most recent one. */
export function remember(digest: string): void {
  try {
    const storage = window.localStorage;
    const others = entries(storage).filter((e) => e.digest !== digest);
    // Later than every other Allow, even several within one millisecond.
    const at = Math.max(Date.now(), (others.at(-1)?.at ?? 0) + 1);
    storage.setItem(ALLOWED_PAGE_KEY_PREFIX + digest, String(at));
    for (const old of others.slice(0, Math.max(0, others.length + 1 - ALLOWED_PAGES_MAX))) {
      storage.removeItem(ALLOWED_PAGE_KEY_PREFIX + old.digest);
    }
  } catch {
    // Not stored: the card shows on the next view, which is no worse than before.
  }
}
