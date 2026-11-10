/**
 * What one signed-in account keeps in this browser's `localStorage`: entries
 * under a prefix that names the account, which signing out clears as one.
 *
 * The account id is URI-encoded and closed with a `/`, which encoding never
 * leaves in an id, so no account's prefix is the start of another's, whatever
 * its id holds.
 */
const ACCOUNT_KEY_ROOT = 'bevel.account/';

/** The prefix of every entry this account keeps. May throw on an id that cannot be encoded: callers treat it as storage that will not store. */
export function accountKeyPrefix(accountId: string): string {
  return `${ACCOUNT_KEY_ROOT}${encodeURIComponent(accountId)}/`;
}

/**
 * Remove every entry this account keeps, and no other's. Never throws: signing
 * out must finish whatever the browser's storage does, and a storage that
 * cannot be touched is one nothing can be read back from either.
 */
export function clearAccountStorage(accountId: string): void {
  try {
    const storage = window.localStorage;
    const prefix = accountKeyPrefix(accountId);
    const keys = Array.from({ length: storage.length }, (_, i) => storage.key(i));
    for (const key of keys) {
      if (key?.startsWith(prefix)) storage.removeItem(key);
    }
  } catch {
    // Nothing more can be done here; the entries still answer to this account alone.
  }
}
