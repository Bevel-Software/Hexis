import { describe, it, expect } from 'vitest';
import { deriveTenantSecrets } from '../tenant-secrets.js';

const MASTER = 'a-master-key-that-is-long-enough-to-count-as-random';

describe('deriveTenantSecrets', () => {
  it('is reproducible: the same master key and slug give the same secrets, on the day of an export too', () => {
    expect(deriveTenantSecrets(MASTER, 'acme')).toEqual(deriveTenantSecrets(MASTER, 'acme'));
  });

  it('gives each tenant, and each of the three secrets, a value of its own', () => {
    const acme = deriveTenantSecrets(MASTER, 'acme');
    const globex = deriveTenantSecrets(MASTER, 'globex');
    expect(acme.jwtSecret).not.toBe(globex.jwtSecret);
    expect(acme.secretsEncKey).not.toBe(globex.secretsEncKey);
    expect(acme.internalTokenSecret).not.toBe(globex.internalTokenSecret);
    expect(new Set([acme.jwtSecret, acme.secretsEncKey, acme.internalTokenSecret]).size).toBe(3);
  });

  it('derives 32-byte keys, which is what the vault encryption requires', () => {
    const { secretsEncKey } = deriveTenantSecrets(MASTER, 'acme');
    expect(Buffer.from(secretsEncKey, 'base64')).toHaveLength(32);
  });

  it('changes every secret when the master key changes', () => {
    const a = deriveTenantSecrets(MASTER, 'acme');
    const b = deriveTenantSecrets(`${MASTER}-rotated`, 'acme');
    expect(a.jwtSecret).not.toBe(b.jwtSecret);
  });

  it('refuses a master key too short to be random, and a missing slug', () => {
    expect(() => deriveTenantSecrets('short', 'acme')).toThrow(/TENANT_MASTER_KEY/);
    expect(() => deriveTenantSecrets(MASTER, '')).toThrow(/slug/);
  });
});
