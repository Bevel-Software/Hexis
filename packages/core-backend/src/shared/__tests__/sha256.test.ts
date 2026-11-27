import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { sha256Base64, sha256Hex } from '@bevel-software/platform-shared';

/**
 * The dependency-free SHA-256 an HTML page's consent memory keys on. It must
 * be SHA-256 exactly: pinned to the published vectors, and agreeing with
 * Node's own implementation across the padding boundaries and multi-byte
 * text.
 */
describe('sha256Hex', () => {
  it('answers the published FIPS 180-4 vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
    expect(sha256Hex('a'.repeat(1_000_000))).toBe('cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
  });

  it('hashes the UTF-8 bytes of the exact string, as Node does', () => {
    const samples = ['<p>Grüße, 日本語 🚀</p>', ' trailing\n', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(63), 'x'.repeat(64), 'x'.repeat(119)];
    for (const text of samples) {
      expect(sha256Hex(text)).toBe(createHash('sha256').update(text, 'utf8').digest('hex'));
    }
  });

  it('changes with one character', () => {
    expect(sha256Hex('<html>a</html>')).not.toBe(sha256Hex('<html>b</html>'));
  });
});

/** The same digest in the base64 form a page frame's Content-Security-Policy lists its scripts by. */
describe('sha256Base64', () => {
  it('answers the published FIPS 180-4 vectors', () => {
    expect(sha256Base64('')).toBe('47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=');
    expect(sha256Base64('abc')).toBe('ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=');
  });

  it('is the bytes sha256Hex names, base64-encoded as Node encodes them', () => {
    const samples = ['', 'abc', '<p>Grüße, 日本語 🚀</p>', 'x'.repeat(55), 'x'.repeat(64), "document.getElementById('a').textContent = 'ran';"];
    for (const text of samples) {
      expect(sha256Base64(text)).toBe(Buffer.from(sha256Hex(text), 'hex').toString('base64'));
      expect(sha256Base64(text)).toBe(createHash('sha256').update(text, 'utf8').digest('base64'));
    }
  });
});
