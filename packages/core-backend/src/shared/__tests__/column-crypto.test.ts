import { describe, expect, it, beforeAll, afterEach, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  PII_CIPHERTEXT_PREFIX,
  PII_SEALED_SHAPE_SQL_REGEX,
  blindIndex,
  decryptPii,
  encryptPii,
  initColumnCrypto,
  isEncryptedBlob,
} from '../column-crypto.js';
import { TokenCrypto } from '../token-crypto.js';

const KEY = randomBytes(32).toString('base64');

beforeAll(() => {
  initColumnCrypto(KEY);
});

// The key is module-global: a test that re-keys and then fails must not leak
// its key into the tests after it.
afterEach(() => {
  initColumnCrypto(KEY);
});

describe('encryptPii / decryptPii', () => {
  it('round-trips a value through ciphertext', () => {
    const sealed = encryptPii('razvan@bevel.software');
    expect(sealed).not.toContain('razvan');
    expect(sealed.startsWith(PII_CIPHERTEXT_PREFIX)).toBe(true);
    expect(isEncryptedBlob(sealed)).toBe(true);
    expect(decryptPii(sealed)).toBe('razvan@bevel.software');
  });

  it('stores the empty string as itself (no unparseable empty-ciphertext blob)', () => {
    expect(encryptPii('')).toBe('');
    expect(decryptPii('')).toBe('');
    expect(isEncryptedBlob('')).toBe(false);
  });

  it('is randomized — the same plaintext never encrypts to the same blob', () => {
    expect(encryptPii('alice')).not.toBe(encryptPii('alice'));
  });

  it('passes legacy plaintext through unchanged (pre-backfill rows)', () => {
    expect(decryptPii('plain old email@example.com')).toBe('plain old email@example.com');
    expect(decryptPii('')).toBe('');
  });

  it('passes through plaintext that merely resembles ciphertext', () => {
    // Blob-shaped but unprefixed (the legacy TokenCrypto shape) → plaintext.
    const shapeOnly = new TokenCrypto(KEY).encrypt('not-a-pii-blob');
    expect(isEncryptedBlob(shapeOnly)).toBe(false);
    expect(decryptPii(shapeOnly)).toBe(shapeOnly);
    // Prefixed but malformed → still not a blob.
    const impostor = `${PII_CIPHERTEXT_PREFIX}abc:def:ghi`;
    expect(isEncryptedBlob(impostor)).toBe(false);
    expect(decryptPii(impostor)).toBe(impostor);
  });

  it('the SQL shape regex agrees with isEncryptedBlob on what a sealed value is', () => {
    // The backfill trusts rows matching this regex as sealed and skips them;
    // the app-side check is the authority. Pinned together here so a change
    // to the prefix, IV or tag width in one place fails this test.
    const regex = new RegExp(PII_SEALED_SHAPE_SQL_REGEX);
    for (const plain of ['a@b.co', 'razvan@bevel.software', 'x'.repeat(500)]) {
      const sealed = encryptPii(plain);
      expect(isEncryptedBlob(sealed)).toBe(true);
      expect(regex.test(sealed)).toBe(true);
    }
    for (const unsealed of ['a@b.co', '', `${PII_CIPHERTEXT_PREFIX}abc:def:ghi`, new TokenCrypto(KEY).encrypt('x')]) {
      expect(isEncryptedBlob(unsealed)).toBe(false);
      expect(regex.test(unsealed)).toBe(false);
    }
  });

  it('a re-init with a different key cannot decrypt: fallback returns the blob', () => {
    const sealed = encryptPii('secret-person@example.com');
    initColumnCrypto(randomBytes(32).toString('base64'));
    // Wrong key → GCM auth failure → plaintext fallback returns the blob as-is.
    expect(decryptPii(sealed)).toBe(sealed);
    initColumnCrypto(KEY);
    expect(decryptPii(sealed)).toBe('secret-person@example.com');
  });

  it('use before initColumnCrypto throws instead of handing back the blob', async () => {
    // A fresh module instance has no key. The decrypt fallback is for a
    // different key, not for no key: that would read sealed rows as blobs.
    vi.resetModules();
    const fresh = await import('../column-crypto.js');
    const sealed = encryptPii('secret-person@example.com');
    expect(fresh.isColumnCryptoInitialised()).toBe(false);
    expect(() => fresh.decryptPii(sealed)).toThrow(/initColumnCrypto/);
    expect(() => fresh.encryptPii('x')).toThrow(/initColumnCrypto/);
    expect(() => fresh.blindIndex('x')).toThrow(/initColumnCrypto/);
  });

  it('domain-separates from the raw secrets key via HKDF', () => {
    // The column key is DERIVED from KEY — a TokenCrypto built from the raw
    // KEY itself must not be able to open a PII blob's body.
    const sealed = encryptPii('secret-person@example.com');
    const body = sealed.slice(PII_CIPHERTEXT_PREFIX.length);
    expect(() => new TokenCrypto(KEY).decrypt(body)).toThrow();
  });
});

describe('blindIndex', () => {
  it('is deterministic and case/whitespace-insensitive', () => {
    expect(blindIndex('Alice@Example.com ')).toBe(blindIndex('alice@example.com'));
    expect(blindIndex('alice@example.com')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs across values', () => {
    expect(blindIndex('a@example.com')).not.toBe(blindIndex('b@example.com'));
  });

  it('differs across keys', () => {
    const first = blindIndex('a@example.com');
    initColumnCrypto(randomBytes(32).toString('base64'));
    expect(blindIndex('a@example.com')).not.toBe(first);
  });
});
