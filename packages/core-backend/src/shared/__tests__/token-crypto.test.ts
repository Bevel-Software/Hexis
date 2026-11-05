import { describe, it, expect } from 'vitest';
import { TokenCrypto } from '../token-crypto.js';
import { randomBytes } from 'node:crypto';

/**
 * The contract an operator meets at boot: a wrong-length key must name the
 * variable THEY set. The error used to hardcode `SHAREPOINT_TOKEN_ENC_KEY` —
 * the primitive's birthplace — and a core deployment failing on its vault key
 * was told to fix a SharePoint variable it never configured.
 */
describe('TokenCrypto key validation', () => {
  // 30 bytes — the classic wrong key: 40 base64 chars instead of 44.
  const SHORT = randomBytes(30).toString('base64');

  it('names SECRETS_ENC_KEY by default — the variable every core consumer reads', () => {
    expect(() => new TokenCrypto(SHORT)).toThrowError(
      /^SECRETS_ENC_KEY must decode to 32 bytes \(got 30\)/,
    );
  });

  it('names the variable an overlay passes for its own key', () => {
    expect(() => new TokenCrypto(SHORT, 'SHAREPOINT_TOKEN_ENC_KEY')).toThrowError(
      /^SHAREPOINT_TOKEN_ENC_KEY must decode to 32 bytes/,
    );
  });

  it('accepts a 32-byte key as base64 and as hex, and round-trips', () => {
    const raw = randomBytes(32);
    for (const encoded of [raw.toString('base64'), raw.toString('hex')]) {
      const crypto = new TokenCrypto(encoded);
      expect(crypto.decrypt(crypto.encrypt('s3cret'))).toBe('s3cret');
    }
  });
});
