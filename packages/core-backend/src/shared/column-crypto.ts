import { createHmac, hkdfSync } from 'node:crypto';
import { customType } from 'drizzle-orm/pg-core';
import { TokenCrypto, assertKeyDecodesTo32Bytes } from './token-crypto.js';

/**
 * Application-layer encryption for PII columns. Personal data (emails, names,
 * change-request text) is AES-256-GCM ciphertext in Postgres, so a leaked
 * dump, an injected query, or a compromised DB credential yields no personal
 * data — the key lives only in the app's environment. Disk-level encryption
 * still carries the blanket at-rest claim (git refs, WAL, logs); this layer is
 * the DB-specific control on top.
 *
 * Both keys are HKDF-derived from `SECRETS_ENC_KEY` with distinct info
 * strings, so PII ciphertext and blind indexes are domain-separated from the
 * secrets-vault key without asking operators to provision a second variable.
 *
 * Module-level state rather than DI, deliberately: the drizzle column type
 * below is referenced from the schema module, which is imported long before
 * any composition root runs. {@link initColumnCrypto} must therefore be called
 * before the first query — `CoreConfig`'s constructor does it the moment the
 * key is validated, so anything that can reach a database has already passed
 * through it.
 */

let columnCrypto: TokenCrypto | null = null;
let bidxKey: Buffer | null = null;

/** Derive and install the PII column + blind-index keys. Idempotent. */
export function initColumnCrypto(secretsEncKey: string): void {
  const ikm = assertKeyDecodesTo32Bytes(secretsEncKey, 'SECRETS_ENC_KEY');
  const columnKey = Buffer.from(hkdfSync('sha256', ikm, Buffer.alloc(0), 'bevel-pii-column-v1', 32));
  bidxKey = Buffer.from(hkdfSync('sha256', ikm, Buffer.alloc(0), 'bevel-pii-bidx-v1', 32));
  columnCrypto = new TokenCrypto(columnKey.toString('base64'));
}

function requireCrypto(): TokenCrypto {
  if (!columnCrypto) {
    throw new Error(
      'PII column crypto used before initColumnCrypto() — construct CoreConfig (or call initColumnCrypto) before touching the database.',
    );
  }
  return columnCrypto;
}

/**
 * Every PII ciphertext starts with this marker. An explicit prefix — rather
 * than recognising ciphertext by its `iv:tag:ct` shape — means legacy
 * plaintext can never be mistaken for ciphertext (and silently skipped by the
 * backfill), and lets the backfill find unsealed rows with a plain SQL
 * `NOT LIKE 'pii:v1:%'` instead of scanning every row in the app. Bump the
 * version segment if the format ever changes.
 */
export const PII_CIPHERTEXT_PREFIX = 'pii:v1:';

/**
 * Whether `value` is a PII ciphertext blob: the version prefix followed by
 * TokenCrypto's `iv:tag:ct` (12-byte IV, 16-byte tag, base64 parts). Used to
 * tell ciphertext from legacy plaintext during the backfill and in
 * {@link decryptPii}'s fallback.
 */
export function isEncryptedBlob(value: string): boolean {
  if (!value.startsWith(PII_CIPHERTEXT_PREFIX)) return false;
  const parts = value.slice(PII_CIPHERTEXT_PREFIX.length).split(':');
  if (parts.length !== 3) return false;
  const [iv, tag, ct] = parts;
  if (!iv || !tag || !ct) return false;
  const b64 = /^[A-Za-z0-9+/]+={0,2}$/;
  if (!b64.test(iv) || !b64.test(tag) || !b64.test(ct)) return false;
  return Buffer.from(iv, 'base64').length === 12 && Buffer.from(tag, 'base64').length === 16;
}

/**
 * Encrypt a PII value for storage (fresh random IV — NOT equality-comparable).
 *
 * The empty string is stored as itself: it carries no personal data, GCM of an
 * empty plaintext would produce an empty ciphertext segment the blob parser
 * cannot represent, and columns with a DB-level `DEFAULT ''` (which bypasses
 * this function entirely) then hold exactly the same representation as an
 * app-written empty value.
 */
export function encryptPii(value: string): string {
  if (value === '') return '';
  return PII_CIPHERTEXT_PREFIX + requireCrypto().encrypt(value);
}

/**
 * Decrypt a stored PII value. A value that does not carry the ciphertext
 * prefix — or fails to decrypt (a different key) — is returned as-is: rows
 * written before the encryption release stay readable until the boot-time
 * backfill rewrites them.
 */
export function decryptPii(value: string): string {
  if (!isEncryptedBlob(value)) return value;
  try {
    return requireCrypto().decrypt(value.slice(PII_CIPHERTEXT_PREFIX.length));
  } catch {
    return value;
  }
}

/**
 * Blind index for equality lookups on encrypted columns: HMAC-SHA256 of the
 * trimmed, lower-cased value, hex-encoded. Deterministic, so a `*_bidx`
 * column can carry the unique constraints and `eq()` lookups that randomized
 * ciphertext cannot. Reveals only equality, never content.
 */
export function blindIndex(value: string): string {
  if (!bidxKey) {
    throw new Error(
      'PII blind-index key used before initColumnCrypto() — construct CoreConfig (or call initColumnCrypto) before touching the database.',
    );
  }
  return createHmac('sha256', bidxKey).update(value.trim().toLowerCase()).digest('hex');
}

/**
 * Drizzle column type for encrypted PII text: services read and write
 * plaintext, the database only ever sees ciphertext. NEVER use an
 * `encryptedText` column in a WHERE clause or conflict target — the fresh IV
 * per write means `eq(column, plaintext)` silently matches nothing. Equality
 * goes through the column's `*_bidx` companion and {@link blindIndex}.
 */
export const encryptedText = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'text';
  },
  toDriver(value: string): string {
    return encryptPii(value);
  },
  fromDriver(value: string): string {
    return decryptPii(value);
  },
});
