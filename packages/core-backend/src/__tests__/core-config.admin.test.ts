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
};

let saved: NodeJS.ProcessEnv;

beforeEach(() => {
  saved = { ...process.env };
  // A clean slate for the keys under test; anything else the constructor reads
  // has a default or is supplied by REQUIRED.
  for (const key of ['ADMIN_EMAIL', 'ADMIN_PASSWORD', 'LOGIN_PASSWORD', 'SEED_ADMIN_EMAILS']) {
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

  it('ignores a leftover SEED_ADMIN_EMAILS instead of failing on it', () => {
    // The variable is gone, not renamed. An operator upgrading with a stale
    // value in their env should boot, not hit an unknown-key error.
    process.env.SEED_ADMIN_EMAILS = 'someone-else@example.com';
    expect(() => new CoreConfig()).not.toThrow();
  });
});
