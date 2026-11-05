import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CoreConfig } from '../core-config.js';

/**
 * The boot contract around the deployment owner.
 *
 * `ADMIN_EMAIL` is required outright — it is the always-admin, the initial
 * Admin written into a freshly seeded `roles.yaml`, and half the bootstrap
 * credential. A deployment without one cannot be administered at all, so
 * refusing to boot beats booting into something nobody can get into.
 *
 * `ADMIN_PASSWORD` is required only while password login is ENABLED. An
 * SSO-only deployment would otherwise have to hold a shared password the
 * server is configured to reject — an unused credential someone still has to
 * store and rotate.
 */
const REQUIRED = {
  KB_REPO_URL: 'https://example.com/org/kb.git',
  ADMIN_EMAIL: 'root@example.com',
  ADMIN_PASSWORD: 'sup3r-secret',
  // The other two boot requirements, so a case about the admin pair fails for
  // the reason it is testing rather than for a missing neighbour.
  JWT_SECRET: 'test-jwt-secret',
  SECRETS_ENC_KEY: 'kToAi8FXWDpDn3A6yQ/60O39bv05N7XzVOIu/0CJrFc=',
};

let saved: NodeJS.ProcessEnv;

beforeEach(() => {
  saved = { ...process.env };
  // A clean slate for the keys under test; anything else the constructor reads
  // has a default or is supplied by REQUIRED.
  for (const key of [
    'ADMIN_EMAIL',
    'ADMIN_PASSWORD',
    'LOGIN_PASSWORD',
    'SEED_ADMIN_EMAILS',
    'JWT_SECRET',
    'SECRETS_ENC_KEY',
    'CONNECTOR_CONFIG_ENC_KEY',
    'SHAREPOINT_TOKEN_ENC_KEY',
  ]) {
    delete process.env[key];
  }
  Object.assign(process.env, REQUIRED);
});

afterEach(() => {
  process.env = saved;
});

describe('CoreConfig — the deployment owner', () => {
  it('refuses to boot without ADMIN_EMAIL', () => {
    delete process.env.ADMIN_EMAIL;
    expect(() => new CoreConfig()).toThrow(/ADMIN_EMAIL is required/);
  });

  it('refuses a malformed ADMIN_EMAIL rather than seeding a broken roles.yaml', () => {
    process.env.ADMIN_EMAIL = 'not-an-email';
    expect(() => new CoreConfig()).toThrow(/not a valid email/);
  });

  it('requires ADMIN_PASSWORD while password login is enabled', () => {
    delete process.env.ADMIN_PASSWORD;
    expect(() => new CoreConfig()).toThrow(/ADMIN_PASSWORD is required/);
  });

  it('does NOT require ADMIN_PASSWORD on an SSO-only deployment', () => {
    delete process.env.ADMIN_PASSWORD;
    process.env.LOGIN_PASSWORD = 'false';
    const config = new CoreConfig();
    expect(config.loginPasswordEnabled).toBe(false);
    expect(config.adminPassword).toBe('');
    // The identity is still there — "there is always an identifiable admin"
    // holds whether or not a password exists.
    expect(config.adminEmail).toBe('root@example.com');
  });

  it('normalizes the owner address, since it is matched against sign-in emails', () => {
    process.env.ADMIN_EMAIL = '  Root@Example.COM  ';
    expect(new CoreConfig().adminEmail).toBe('root@example.com');
  });

  /**
   * Both sign what the deployment hands out — sessions, and the git credential
   * the setup screen stores. Unset, the failure used to surface at the first
   * login or the last step of first-run setup; a boot error naming the variable
   * is the same information, much earlier.
   */
  it('refuses to boot without JWT_SECRET', () => {
    delete process.env.JWT_SECRET;
    expect(() => new CoreConfig()).toThrow(/JWT_SECRET is required/);
  });

  it('refuses to boot without SECRETS_ENC_KEY', () => {
    delete process.env.SECRETS_ENC_KEY;
    expect(() => new CoreConfig()).toThrow(/SECRETS_ENC_KEY is required/);
  });

  it('still accepts the legacy encryption-key names', () => {
    delete process.env.SECRETS_ENC_KEY;
    process.env.CONNECTOR_CONFIG_ENC_KEY = 'kToAi8FXWDpDn3A6yQ/60O39bv05N7XzVOIu/0CJrFc=';
    // Not just "does not throw": the legacy name has to actually supply the
    // key, or an existing deployment boots and then cannot decrypt anything.
    expect(new CoreConfig().secretsEncKey).toBe('kToAi8FXWDpDn3A6yQ/60O39bv05N7XzVOIu/0CJrFc=');
  });

  /**
   * A wrong-length key fails at BOOT, blaming the variable that supplied it.
   * The length check used to live only inside `TokenCrypto`'s consumers,
   * which blame `SECRETS_ENC_KEY` by default — right for the common case,
   * a lie to a legacy deployment whose key arrives through the fallback
   * chain. Validating here, where the winning name is known, is what makes
   * the downstream default safe.
   */
  it('refuses a wrong-length key at boot, naming SECRETS_ENC_KEY when that supplied it', () => {
    process.env.SECRETS_ENC_KEY = Buffer.alloc(30).toString('base64'); // 40 chars → 30 bytes
    expect(() => new CoreConfig()).toThrow(/SECRETS_ENC_KEY must decode to 32 bytes \(got 30\)/);
  });

  it('blames the legacy variable when the wrong-length key came through the fallback chain', () => {
    delete process.env.SECRETS_ENC_KEY;
    process.env.SHAREPOINT_TOKEN_ENC_KEY = Buffer.alloc(30).toString('base64');
    expect(() => new CoreConfig()).toThrow(
      /SHAREPOINT_TOKEN_ENC_KEY must decode to 32 bytes \(got 30\)/,
    );
  });

  it('ignores a leftover SEED_ADMIN_EMAILS instead of failing on it', () => {
    // The variable is gone, not renamed. An operator upgrading with a stale
    // value in their env should boot, not hit an unknown-key error.
    process.env.SEED_ADMIN_EMAILS = 'someone-else@example.com';
    expect(() => new CoreConfig()).not.toThrow();
  });
});
