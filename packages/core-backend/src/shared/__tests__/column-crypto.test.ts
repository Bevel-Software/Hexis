import { describe, expect, it, beforeAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  blindIndex,
  decryptPii,
  encryptPii,
  initColumnCrypto,
  isEncryptedBlob,
} from '../column-crypto.js';

const KEY = randomBytes(32).toString('base64');

beforeAll(() => {
  initColumnCrypto(KEY);
});

describe('encryptPii / decryptPii', () => {
  it('round-trips a value through ciphertext', () => {
    const sealed = encryptPii('razvan@bevel.software');
    expect(sealed).not.toContain('razvan');
    expect(isEncryptedBlob(sealed)).toBe(true);
    expect(decryptPii(sealed)).toBe('razvan@bevel.software');
  });

  it('is randomized — the same plaintext never encrypts to the same blob', () => {
    expect(encryptPii('alice')).not.toBe(encryptPii('alice'));
  });

  it('passes legacy plaintext through unchanged (pre-backfill rows)', () => {
    expect(decryptPii('plain old email@example.com')).toBe('plain old email@example.com');
    expect(decryptPii('')).toBe('');
  });

  it('passes through a colon-y plaintext that merely resembles the blob shape', () => {
    // Three base64-ish segments but wrong decoded lengths → not a blob.
    const impostor = 'abc:def:ghi';
    expect(isEncryptedBlob(impostor)).toBe(false);
    expect(decryptPii(impostor)).toBe(impostor);
  });

  it('domain-separates from the raw secrets key: a different init decrypts nothing', () => {
    const sealed = encryptPii('secret-person@example.com');
    initColumnCrypto(randomBytes(32).toString('base64'));
    // Wrong key → GCM auth failure → plaintext fallback returns the blob as-is.
    expect(decryptPii(sealed)).toBe(sealed);
    initColumnCrypto(KEY);
    expect(decryptPii(sealed)).toBe('secret-person@example.com');
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
    initColumnCrypto(KEY);
  });
});
