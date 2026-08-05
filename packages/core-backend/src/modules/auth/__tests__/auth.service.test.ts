import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../../database/connection.js';
import type { CoreConfig } from '../../../core-config.js';
import { AuthService } from '../auth.service.js';
import { hashPassword } from '../password-hash.js';

/**
 * Minimal drizzle chain stub (same idiom as the secrets-vault tests): each
 * db.select()/insert()/update() consumes the next queued result; awaiting any
 * point of the chain resolves it.
 */
interface FakeChain extends PromiseLike<unknown> {
  values: (...args: unknown[]) => FakeChain;
  set: (...args: unknown[]) => FakeChain;
  where: (...args: unknown[]) => FakeChain;
  limit: (...args: unknown[]) => FakeChain;
  from: (...args: unknown[]) => FakeChain;
  orderBy: (...args: unknown[]) => FakeChain;
  returning: (...args: unknown[]) => FakeChain;
  onConflictDoUpdate: (...args: unknown[]) => FakeChain;
}

function makeFakeDb(queue: unknown[]) {
  const captured: { values: unknown[]; set: unknown[]; conflict: unknown[] } = {
    values: [],
    set: [],
    conflict: [],
  };
  function nextChain(): FakeChain {
    const result = queue.shift();
    const passthrough = (recorder?: (args: unknown[]) => void) =>
      vi.fn((...args: unknown[]) => {
        recorder?.(args);
        return chain;
      });
    const chain: FakeChain = {
      values: passthrough((a) => captured.values.push(a[0])),
      set: passthrough((a) => captured.set.push(a[0])),
      where: passthrough(),
      limit: passthrough(),
      from: passthrough(),
      orderBy: passthrough(),
      returning: passthrough(),
      onConflictDoUpdate: passthrough((a) => captured.conflict.push(a[0])),
      then: (onFulfilled, onRejected) => Promise.resolve(result).then(onFulfilled, onRejected),
    };
    return chain;
  }
  const db = {
    insert: vi.fn(() => nextChain()),
    select: vi.fn(() => nextChain()),
    update: vi.fn(() => nextChain()),
  } as unknown as Database;
  return { db, captured };
}

function makeConfig(over: Partial<CoreConfig> = {}): CoreConfig {
  return {
    jwtSecret: 'test-jwt-secret',
    adminEmail: '',
    adminPassword: '',
    allowedEmailDomains: [],
    ...over,
  } as CoreConfig;
}

const ROW = {
  id: 'user-1',
  email: 'alice@example.com',
  name: 'Alice',
  avatarUrl: null,
};

describe('AuthService.loginWithPassword — env bootstrap admin', () => {
  const config = makeConfig({ adminEmail: 'root@example.com', adminPassword: 'sup3r-secret' });

  it('signs in the env admin and upserts their user row', async () => {
    const { db } = makeFakeDb([[{ ...ROW, email: 'root@example.com', name: 'root' }]]);
    const svc = new AuthService(db, config);
    const result = await svc.loginWithPassword('Root@Example.com', 'sup3r-secret');
    expect(result.user.email).toBe('root@example.com');
    expect(result.token.length).toBeGreaterThan(20);
  });

  it('rejects the admin email with a wrong password (and does not fall back oddly)', async () => {
    // Wrong env password → falls through to the DB path; no row → refused.
    const { db } = makeFakeDb([[]]);
    const svc = new AuthService(db, config);
    await expect(svc.loginWithPassword('root@example.com', 'wrong')).rejects.toThrow(
      'Invalid credentials',
    );
  });

  it('is disabled entirely when either env var is empty', async () => {
    for (const cfg of [
      makeConfig({ adminEmail: 'root@example.com', adminPassword: '' }),
      makeConfig({ adminEmail: '', adminPassword: 'sup3r-secret' }),
    ]) {
      const { db } = makeFakeDb([[]]);
      const svc = new AuthService(db, cfg);
      await expect(svc.loginWithPassword('root@example.com', 'sup3r-secret')).rejects.toThrow(
        'Invalid credentials',
      );
    }
  });
});

describe('AuthService.loginWithPassword — per-user accounts', () => {
  it('accepts a user whose stored hash matches', async () => {
    const passwordHash = await hashPassword('alices-password');
    const { db } = makeFakeDb([[{ ...ROW, passwordHash }]]);
    const svc = new AuthService(db, makeConfig());
    const result = await svc.loginWithPassword('alice@example.com', 'alices-password');
    expect(result.user.id).toBe('user-1');
  });

  it('rejects a wrong password and an account with no password set', async () => {
    const passwordHash = await hashPassword('alices-password');
    const withHash = makeFakeDb([[{ ...ROW, passwordHash }]]);
    await expect(
      new AuthService(withHash.db, makeConfig()).loginWithPassword('alice@example.com', 'nope'),
    ).rejects.toThrow('Invalid credentials');

    // SSO-only account: row exists but has no hash.
    const noHash = makeFakeDb([[{ ...ROW, passwordHash: null }]]);
    await expect(
      new AuthService(noHash.db, makeConfig()).loginWithPassword('alice@example.com', 'anything'),
    ).rejects.toThrow('Invalid credentials');
  });

  it('never leaks whether the email exists — same error for unknown emails', async () => {
    const { db } = makeFakeDb([[]]);
    await expect(
      new AuthService(db, makeConfig()).loginWithPassword('ghost@example.com', 'whatever'),
    ).rejects.toThrow('Invalid credentials');
  });
});

describe('AuthService.createAccount / changePassword', () => {
  it('createAccount upserts the user in ONE query and stores a verifying hash', async () => {
    const { db, captured } = makeFakeDb([[ROW]]);
    const svc = new AuthService(db, makeConfig());
    const user = await svc.createAccount('alice@example.com', 'Alice', 'brand-new-pass');
    expect(user.email).toBe('alice@example.com');
    // Insert values carry the hash; the conflict branch re-sets it too.
    const values = captured.values[0] as { passwordHash: string; name: string };
    expect(values.passwordHash.startsWith('scrypt:')).toBe(true);
    expect(values.name).toBe('Alice');
    const conflict = captured.conflict[0] as { set: { passwordHash: string } };
    expect(conflict.set.passwordHash.startsWith('scrypt:')).toBe(true);
  });

  it('createAccount persists an explicitly supplied name on re-provisioning', async () => {
    // Existing row conflicts; admin re-provisions with a new name.
    const { db, captured } = makeFakeDb([[{ ...ROW, name: 'Alice Lidell' }]]);
    const svc = new AuthService(db, makeConfig());
    const user = await svc.createAccount('alice@example.com', 'Alice Lidell', 'brand-new-pass');
    const conflict = captured.conflict[0] as { set: { name?: string } };
    expect(conflict.set.name).toBe('Alice Lidell');
    expect(user.name).toBe('Alice Lidell');
  });

  it('createAccount without a name keeps the existing display name on conflict', async () => {
    const { db, captured } = makeFakeDb([[ROW]]);
    const svc = new AuthService(db, makeConfig());
    const user = await svc.createAccount('alice@example.com', undefined, 'brand-new-pass');
    const conflict = captured.conflict[0] as { set: { name?: string } };
    expect(conflict.set.name).toBeUndefined();
    expect(user.name).toBe('Alice');
  });

  it('createAccount enforces the password policy', async () => {
    const { db } = makeFakeDb([]);
    const svc = new AuthService(db, makeConfig());
    await expect(svc.createAccount('alice@example.com', 'Alice', 'short')).rejects.toThrow(
      /at least/,
    );
  });

  it('changePassword requires the current password once one is set', async () => {
    const passwordHash = await hashPassword('old-password');
    const wrong = makeFakeDb([[{ ...ROW, passwordHash }]]);
    await expect(
      new AuthService(wrong.db, makeConfig()).changePassword('user-1', 'not-it', 'new-password-1'),
    ).rejects.toThrow('Current password is incorrect');

    const right = makeFakeDb([[{ ...ROW, passwordHash }], undefined]);
    await expect(
      new AuthService(right.db, makeConfig()).changePassword('user-1', 'old-password', 'new-password-1'),
    ).resolves.toBeUndefined();
  });

  it('changePassword lets an SSO-only account set its first password without one', async () => {
    const { db, captured } = makeFakeDb([[{ ...ROW, passwordHash: null }], undefined]);
    await new AuthService(db, makeConfig()).changePassword('user-1', undefined, 'first-password');
    const set = captured.set[0] as { passwordHash: string };
    expect(set.passwordHash.startsWith('scrypt:')).toBe(true);
  });
});

describe('AuthService.listAccounts', () => {
  it('reports hasPassword without ever exposing the hash', async () => {
    const passwordHash = await hashPassword('pw-longer-than-8');
    const { db } = makeFakeDb([
      [
        { ...ROW, passwordHash, createdAt: new Date() },
        { ...ROW, id: 'user-2', email: 'bob@example.com', name: 'Bob', passwordHash: null, createdAt: new Date() },
      ],
    ]);
    const accounts = await new AuthService(db, makeConfig()).listAccounts();
    expect(accounts.map((a) => [a.email, a.hasPassword])).toEqual([
      ['alice@example.com', true],
      ['bob@example.com', false],
    ]);
    expect(JSON.stringify(accounts)).not.toContain('scrypt:');
  });
});

/**
 * `ALLOWED_EMAIL_DOMAINS` is the SSO allow-list, and only that.
 *
 * It exists because SSO AUTO-PROVISIONS — `loginWithSso` upserts the account
 * the first time the issuer authenticates someone, with nobody approving it.
 * Against a multi-tenant issuer (Google, the Entra `common` endpoint) it is the
 * only thing between "has an account somewhere" and "has an account here.
 *
 * The other two entry points do not have that property, which is why the guard
 * was taken off them: an admin-created account is vetted by the act of creating
 * it, and password login can only reach an account that already exists. The
 * check gated nothing there — while being able to lock out a bootstrap admin
 * whose own address sits outside the list, which the last test pins.
 */
describe('AuthService — the SSO domain allow-list', () => {
  const config = makeConfig({ allowedEmailDomains: ['bevel.software'] });

  it('refuses an SSO sign-in from outside the allow-list', async () => {
    const { db } = makeFakeDb([[]]);
    await expect(
      new AuthService(db, config).loginWithSso('someone@gmail.com', 'Someone'),
    ).rejects.toThrow(/domain is not allowed/i);
  });

  it('admits a subdomain of an allowed domain', async () => {
    const { db } = makeFakeDb([[{ ...ROW, email: 'eu@eu.bevel.software', name: 'EU' }]]);
    const out = await new AuthService(db, config).loginWithSso('eu@eu.bevel.software', 'EU');
    expect(out.user.email).toBe('eu@eu.bevel.software');
  });

  it('does NOT gate an account an admin creates', async () => {
    const { db } = makeFakeDb([[{ ...ROW, email: 'contractor@gmail.com', name: 'Contractor' }]]);
    const account = await new AuthService(db, config).createAccount(
      'contractor@gmail.com',
      'Contractor',
      'pw-longer-than-8',
    );
    expect(account.email).toBe('contractor@gmail.com');
  });

  it('does NOT lock the bootstrap admin out of their own deployment', async () => {
    // The owner's address need not sit inside the SSO allow-list — the list is
    // about who may provision themselves, not about who owns the deployment.
    const outsideConfig = makeConfig({
      allowedEmailDomains: ['bevel.software'],
      adminEmail: 'root@gmail.com',
      adminPassword: 'sup3r-secret',
    });
    const { db } = makeFakeDb([[{ ...ROW, email: 'root@gmail.com', name: 'root' }]]);
    const out = await new AuthService(db, outsideConfig).loginWithPassword(
      'root@gmail.com',
      'sup3r-secret',
    );
    expect(out.user.email).toBe('root@gmail.com');
  });
});
