import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM encryption for at-rest secrets. Output format is
 * `<ivB64>:<tagB64>:<ciphertextB64>` so all three parts travel together in one
 * text column. A DB leak alone yields only ciphertext; the key lives in the
 * app's env, not the database. Shared primitive with several consumers, each
 * bringing its own key: the secrets vault + MCP OAuth store (core), and the
 * SharePoint token cache / connector configs (enterprise).
 */
export class TokenCrypto {
  private readonly key: Buffer;

  /** @param rawKey 32-byte key as hex (64 chars) or base64. */
  constructor(rawKey: string) {
    const key = decodeKey(rawKey);
    if (key.length !== 32) {
      throw new Error(
        `SHAREPOINT_TOKEN_ENC_KEY must decode to 32 bytes (got ${key.length}). ` +
          'Generate one with: `node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"`.',
      );
    }
    this.key = key;
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
  }

  decrypt(blob: string): string {
    const parts = blob.split(':');
    if (parts.length !== 3) {
      throw new Error('TokenCrypto.decrypt: malformed ciphertext blob (expected iv:tag:ct)');
    }
    const [ivB64, tagB64, ctB64] = parts;
    if (!ivB64 || !tagB64 || !ctB64) {
      throw new Error('TokenCrypto.decrypt: malformed ciphertext blob');
    }
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
  }
}

function decodeKey(raw: string): Buffer {
  // Accept hex (64 chars, hex alphabet) or base64. Hex first to avoid a 64-char
  // hex string being misread as base64.
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  return Buffer.from(raw, 'base64');
}
