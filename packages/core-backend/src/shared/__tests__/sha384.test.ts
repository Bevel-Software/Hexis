import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { sha384Base64 } from '@bevel-software/platform-shared';

/**
 * The dependency-free SHA-384 a page frame's second Content-Security-Policy
 * lists its scripts by. It must be SHA-384 exactly, or the browser refuses
 * every script: pinned to the published vectors, and agreeing with Node's
 * own implementation across the padding boundaries and multi-byte text.
 */
describe('sha384Base64', () => {
  const b64 = (hex: string) => Buffer.from(hex, 'hex').toString('base64');

  it('answers the published FIPS 180-4 vectors', () => {
    expect(sha384Base64('')).toBe(b64('38b060a751ac96384cd9327eb1b1e36a21fdb71114be07434c0cc7bf63f6e1da274edebfe76f65fbd51ad2f14898b95b'));
    expect(sha384Base64('abc')).toBe(b64('cb00753f45a35e8bb5a03d699ac65007272c32ab0eded1631a8b605a43ff5bed8086072ba1e7cc2358baeca134c825a7'));
    expect(
      sha384Base64('abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu'),
    ).toBe(b64('09330c33f71147e83d192fc782cd1b4753111b173b3b05d22fa08086e3b0f712fcc7c71a557e2db966c3e9fa91746039'));
    expect(sha384Base64('a'.repeat(1_000_000))).toBe(b64('9d0e1809716474cb086e834e310a4a1ced149e9c00f248527972cec5704c2a5b07b8b3dc38ecc4ebae97ddd87f3d8985'));
  });

  it('hashes the UTF-8 bytes of the exact string, as Node does', () => {
    const samples = ['<p>Grüße, 日本語 🚀</p>', ' trailing\n', ...[111, 112, 127, 128, 239, 240, 255, 256].map((n) => 'x'.repeat(n))];
    for (const text of samples) {
      expect(sha384Base64(text)).toBe(createHash('sha384').update(text, 'utf8').digest('base64'));
    }
  });
});
