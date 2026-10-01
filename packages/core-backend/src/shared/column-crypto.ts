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
 * THE KEY BELONGS TO THE DATABASE HANDLE, not to the process. A process that
 * serves several knowledge bases holds one handle per tenant, each built with
 * that tenant's own `SECRETS_ENC_KEY` (`createDb(url, { piiKey })`), so a
 * tenant's rows are sealed under the same key as its stored credentials and
 * its dump opens, whole, with that one key.
 *
 * A drizzle column type is a module-level object and is told nothing about
 * the handle a statement runs on, so it cannot hold a key. It only MARKS a
 * value ({@link SealOnWrite}, {@link IndexOnWrite}); the handle's own
 * connection replaces the mark with ciphertext or a blind index on the way
 * in, and opens every sealed value on the way out (see `connection.ts`). A
 * mark that reaches a connection with no key refuses to be written.
 *
 * Both keys are HKDF-derived from the handle's key with distinct info
 * strings, so PII ciphertext and blind indexes are domain-separated from the
 * secrets-vault key without asking operators to provision a second variable.
 */

/** What a database handle seals, opens and indexes personal data with. */
export interface PiiKeys {
  /**
   * Encrypt a value for storage (fresh random IV — NOT equality-comparable).
   *
   * The empty string is stored as itself: it carries no personal data, GCM of
   * an empty plaintext would produce an empty ciphertext segment the blob
   * parser cannot represent, and columns with a DB-level `DEFAULT ''` then
   * hold exactly the same representation as an app-written empty value.
   */
  seal(plain: string): string;
  /**
   * Open a stored value, and SAY whether it opened: a value that is not a
   * blob is its own plaintext; a blob this key does not open is `ok: false`.
   * For the callers that must tell "the key does not open this" from a value
   * — the shape of what {@link read} returns proves nothing, since a
   * plaintext may itself be shaped like a blob.
   */
  open(value: string): { ok: true; plain: string } | { ok: false };
  /**
   * The lenient read every query result goes through: a blob this key does
   * not open is handed back as it is, as is anything that is not a blob —
   * rows written before the encryption release stay readable until the
   * backfill at start rewrites them.
   */
  read(value: string): string;
  /**
   * Blind index for equality on an encrypted column: HMAC-SHA256 of the
   * trimmed, lower-cased value, hex-encoded. Deterministic, so a `*_bidx`
   * column can carry the unique constraints and lookups that randomized
   * ciphertext cannot. Reveals only equality, never content.
   */
  index(value: string): string;
}

/** Derive the personal-data keys from a deployment's (or a tenant's) `SECRETS_ENC_KEY`. */
export function derivePiiKeys(secretsEncKey: string): PiiKeys {
  const ikm = assertKeyDecodesTo32Bytes(secretsEncKey, 'SECRETS_ENC_KEY');
  const columnKey = Buffer.from(hkdfSync('sha256', ikm, Buffer.alloc(0), 'bevel-pii-column-v1', 32));
  const bidxKey = Buffer.from(hkdfSync('sha256', ikm, Buffer.alloc(0), 'bevel-pii-bidx-v1', 32));
  const crypto = new TokenCrypto(columnKey.toString('base64'));
  const open: PiiKeys['open'] = (value) => {
    if (!isEncryptedBlob(value)) return { ok: true, plain: value };
    try {
      return { ok: true, plain: crypto.decrypt(value.slice(PII_CIPHERTEXT_PREFIX.length)) };
    } catch {
      return { ok: false };
    }
  };
  return {
    seal: (plain) => (plain === '' ? '' : PII_CIPHERTEXT_PREFIX + crypto.encrypt(plain)),
    open,
    read: (value) => {
      const opened = open(value);
      return opened.ok ? opened.plain : value;
    },
    index: (value) => createHmac('sha256', bidxKey).update(value.trim().toLowerCase()).digest('hex'),
  };
}

/**
 * Every PII ciphertext starts with this marker. An explicit prefix — rather
 * than recognising ciphertext by its `iv:tag:ct` shape — means legacy
 * plaintext can never be mistaken for ciphertext (and silently skipped by the
 * backfill), and lets the backfill find unsealed rows with a plain SQL
 * predicate instead of scanning every row in the app. Bump the version
 * segment if the format ever changes.
 */
export const PII_CIPHERTEXT_PREFIX = 'pii:v1:';

/**
 * Whether `value` is a PII ciphertext blob: the version prefix followed by
 * TokenCrypto's `iv:tag:ct` (12-byte IV, 16-byte tag, base64 parts). Used to
 * tell ciphertext from legacy plaintext during the backfill and on every read.
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
 * The SQL (POSIX regex) counterpart of {@link isEncryptedBlob}: the version
 * prefix followed by base64 segments of the exact widths GCM produces
 * (12-byte IV → 16 chars, 16-byte tag → 22 chars + `==`). Lets the backfill
 * find unsealed rows with a `!~` predicate instead of scanning every row in
 * the app. Lives beside the blob format it mirrors — and is pinned to it by
 * `column-crypto.test.ts` — so the two cannot drift apart.
 */
export const PII_SEALED_SHAPE_SQL_REGEX = `^${PII_CIPHERTEXT_PREFIX}[A-Za-z0-9+/]{16}:[A-Za-z0-9+/]{22}==:[A-Za-z0-9+/]+={0,2}$`;

/**
 * A value on its way to the database that the handle's connection still has
 * to turn into what is stored. It is never a storable value itself: `pg`
 * asks an object how to serialise itself through `toPostgres`, and this one
 * refuses, so a statement that reaches a connection which did not replace it
 * — a pool built without `createDb`, or a handle built without a key — fails
 * instead of writing the plaintext.
 */
export abstract class PiiParam {
  constructor(readonly plain: string) {}

  /** What the handle's keys make of it. */
  abstract stored(keys: PiiKeys): string;

  toPostgres(): never {
    throw new Error(
      'A personal-data value reached a database connection that holds no key for it. ' +
        'Build the handle with createDb/getDb and its piiKey (createCoreServices does).',
    );
  }
}

/** Plaintext of an {@link encryptedText} column: stored as ciphertext. */
export class SealOnWrite extends PiiParam {
  stored(keys: PiiKeys): string {
    return keys.seal(this.plain);
  }
}

/** The address a {@link blindIndexText} column is written or compared with: stored as its blind index. */
export class IndexOnWrite extends PiiParam {
  stored(keys: PiiKeys): string {
    return keys.index(this.plain);
  }
}

/**
 * Drizzle column type for encrypted PII text: services read and write
 * plaintext, the database only ever sees ciphertext. NEVER use an
 * `encryptedText` column in a WHERE clause or conflict target — the fresh IV
 * per write means `eq(column, plaintext)` silently matches nothing. Equality
 * goes through the column's `*_bidx` companion ({@link blindIndexText}).
 */
export const encryptedText = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'text';
  },
  toDriver(value: string): string {
    // The mark, typed as the text it becomes on the handle's connection.
    return (value === '' ? '' : new SealOnWrite(value)) as string;
  },
  fromDriver(value: string): string {
    // Already opened: the handle's connection opens every sealed value of a
    // result before drizzle maps it.
    return value;
  },
});

const STORED_INDEX = /^[0-9a-f]{64}$/;

/**
 * Drizzle column type for the blind index beside an encrypted column. WRITE
 * AND COMPARE IT WITH THE VALUE ITSELF — `emailBidx: email`,
 * `eq(users.emailBidx, email)`, `inArray(users.emailBidx, emails)` — and the
 * handle's connection stores or binds its index. Reading the column gives the
 * stored index, which is good for nothing but SQL: writing it back would
 * index the index, so that is refused. A row copied from another carries the
 * value its index was made from, not the index.
 *
 * Only through drizzle's operators, which bind through the column: a value
 * interpolated into a raw `sql` template is compared as it is and matches
 * nothing.
 */
export const blindIndexText = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'text';
  },
  toDriver(value: string): string {
    if (STORED_INDEX.test(value)) {
      throw new Error(
        'A blind-index column was written with a stored index. Write it with the value the index is of (the address).',
      );
    }
    return new IndexOnWrite(value) as unknown as string;
  },
  fromDriver(value: string): string {
    return value;
  },
});
