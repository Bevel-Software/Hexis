import { accountKeyPrefix } from '../../../auth';

/**
 * Which pages the signed-in account allowed to write from this browser: the
 * SHA-256 digests of the pages' sources. A page whose source hashes to one of
 * them asks that account nothing; a source whose digest is not here, an edit
 * included, asks once more. Kept per account, browser and deployment, and never
 * a deny: Don't allow stores nothing. With no account (`null`) nothing is kept
 * and every view asks.
 *
 * Each digest is its own `localStorage` entry under the account's prefix
 * (the auth module's `accountKeyPrefix`), holding when it was last allowed. An Allow writes
 * only its own entry, so two tabs allowing two pages at once cannot overwrite
 * each other's; eviction past the cap removes only that account's oldest
 * entries. Signing out clears the account's prefix.
 *
 * A browser that cannot store or read them is asked on every view, as it
 * would be with nothing remembered, and is told nothing about it.
 */
const ENTRY_NAME = 'htmlPage.allowedWrite.';

/** How many digests one account keeps: past it, its least recently allowed is forgotten. */
const ALLOWED_PAGES_MAX = 500;

interface Entry {
  digest: string;
  at: number;
}

/** Every digest under this entry prefix with when it was allowed, least recent first. */
function entries(storage: Storage, prefix: string): Entry[] {
  const found: Entry[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key === null || !key.startsWith(prefix)) continue;
    const at = Number(storage.getItem(key));
    if (!Number.isFinite(at)) continue;
    found.push({ digest: key.slice(prefix.length), at });
  }
  return found.sort((a, b) => a.at - b.at);
}

/** Whether this account allowed a page with this digest in this browser. */
export function isRemembered(account: string | null, digest: string): boolean {
  if (account === null) return false;
  try {
    const at = window.localStorage.getItem(accountKeyPrefix(account) + ENTRY_NAME + digest);
    return at !== null && Number.isFinite(Number(at));
  } catch {
    return false;
  }
}

/** Remember this account's Allow for this digest, as its most recent one. */
export function remember(account: string | null, digest: string): void {
  if (account === null) return;
  try {
    const storage = window.localStorage;
    const prefix = accountKeyPrefix(account) + ENTRY_NAME;
    const others = entries(storage, prefix).filter((e) => e.digest !== digest);
    // Later than every other Allow, even several within one millisecond.
    const at = Math.max(Date.now(), (others.at(-1)?.at ?? 0) + 1);
    storage.setItem(prefix + digest, String(at));
    // The cap is enforced on what storage holds AFTER this write, not on the
    // snapshot above, so two tabs allowing at once still leave at most the
    // cap. Each candidate is removed only while it still holds the time just
    // read: one another tab has allowed again since is newer, and is kept.
    const now = entries(storage, prefix).filter((e) => e.digest !== digest);
    for (const old of now.slice(0, Math.max(0, now.length + 1 - ALLOWED_PAGES_MAX))) {
      if (storage.getItem(prefix + old.digest) === String(old.at)) storage.removeItem(prefix + old.digest);
    }
  } catch {
    // Not stored: the card shows on the next view, which is no worse than before.
  }
}
