import { hkdfSync } from 'node:crypto';

/** The three secrets every graph needs, derived rather than stored. */
export interface TenantSecrets {
  /** Signs the tenant's login sessions and OAuth state. */
  jwtSecret: string;
  /** 32 bytes, base64: encrypts the tenant's vault values, MCP OAuth tokens and stored git credential. */
  secretsEncKey: string;
  /** HMAC key for the tenant's internal (loopback) tool tokens. */
  internalTokenSecret: string;
}

/** The least a master key may hold: 32 characters is 256 bits of a random string. */
const MIN_MASTER_KEY_LENGTH = 32;

/**
 * A tenant's secrets from ONE master key and its slug, with HKDF-SHA256:
 * the slug is the salt and each secret's name the info, so the three are
 * independent of each other and of every other tenant's.
 *
 * Derived, not generated and stored, for the hand-over: a tenant that leaves
 * for a dedicated deployment takes a `pg_dump` whose vault rows and stored
 * git token are encrypted under its `secretsEncKey`. With derivation the key
 * is reproducible from the master key and the slug on the day of the
 * export, and nothing per tenant has to be kept safe in the meantime. The
 * cloud app's registry calls this with the same inputs and gets the same
 * answer.
 */
export function deriveTenantSecrets(masterKey: string, slug: string): TenantSecrets {
  if (masterKey.length < MIN_MASTER_KEY_LENGTH) {
    throw new Error(`TENANT_MASTER_KEY must be at least ${MIN_MASTER_KEY_LENGTH} characters of random text`);
  }
  if (!slug) throw new Error('A tenant slug is required to derive its secrets');
  const derive = (info: string): string =>
    Buffer.from(hkdfSync('sha256', masterKey, `hexis-tenant:${slug}`, info, 32)).toString('base64');
  return {
    jwtSecret: derive('jwt-secret'),
    secretsEncKey: derive('secrets-enc-key'),
    internalTokenSecret: derive('internal-token-secret'),
  };
}
