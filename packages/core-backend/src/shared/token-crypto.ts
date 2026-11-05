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

  /**
   * @param rawKey 32-byte key as hex (64 chars) or base64.
   * @param envVarName the environment variable the caller read `rawKey` from,
   *   so a bad key is reported against the variable the operator actually has
   *   to fix. Defaults to core's own `SECRETS_ENC_KEY` — every core consumer
   *   reads that; an overlay bringing its own key (the SharePoint token
   *   cache, connector configs) passes its own name.
   */
  constructor(rawKey: string, envVarName = 'SECRETS_ENC_KEY') {
    this.key = assertKeyDecodesTo32Bytes(rawKey, envVarName);
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

/**
 * Decode a key and refuse anything that is not exactly 32 bytes, blaming
 * `envVarName`. Exported so boot-time config can validate the key THE MOMENT
 * it knows which environment variable supplied it (`SECRETS_ENC_KEY` or a
 * legacy fallback) — every later `new TokenCrypto(key)` with the default name
 * is then safe, because a bad key never gets that far.
 */
export function assertKeyDecodesTo32Bytes(rawKey: string, envVarName: string): Buffer {
  // Whitespace around it is the environment's, not the key's.
  const written = rawKey.trim();
  const key = decodeKey(written);
  if (key.length !== 32) {
    throw new Error(
      `${envVarName} must decode to 32 bytes (got ${key.length}). ` +
        'Generate one with: `node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"`.',
    );
  }
  // WHAT IS WRITTEN MUST BE A SPELLING OF WHAT IT DECODES TO. Node's decoder is
  // forgiving in ways a key must not be: it skips a character it does not know,
  // it stops at padding wherever padding stands, and it ignores bits a final
  // character should not carry. Each of those turns a mistyped key into 32
  // bytes — a DIFFERENT key, sealing data that the value an operator wrote
  // down will never open. Asking which characters and which padding are
  // acceptable is a list that is always one case short, so the question is put
  // the other way round: encode the bytes again, and accept the value only
  // when it is one of the ways those bytes are written.
  if (!spellingsOf(key).includes(/^[0-9a-fA-F]{64}$/.test(written) ? written.toLowerCase() : written)) {
    throw new Error(
      `${envVarName} is not a clean hex or base64 spelling of a 32-byte key: it holds a character, a padding ` +
        'or trailing bits the encoding does not have, which the decoder skipped. The key in use so far is what ' +
        'it decoded to; print that key spelled properly with ' +
        `\`node -e "console.log(Buffer.from(process.env.${envVarName}, 'base64').toString('base64'))"\` and set that.`,
    );
  }
  return key;
}

/** Every way 32 bytes are written as a key: hex, and base64 in either alphabet, padded or not. */
function spellingsOf(key: Buffer): string[] {
  const standard = key.toString('base64');
  const urlSafe = key.toString('base64url');
  const padding = standard.slice(standard.replace(/=+$/, '').length);
  return [key.toString('hex'), standard, standard.replace(/=+$/, ''), urlSafe, urlSafe + padding];
}
