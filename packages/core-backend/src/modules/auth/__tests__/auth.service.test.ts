import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../../database/connection.js';
import type { CoreConfig } from '../../../core-config.js';
import { AuthService } from '../auth.service.js';
import { hashPassword, verifyPassword } from '../password-hash.js';

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
  // NOT NULL with a default in the schema: a row read back from the database
  // always has a boolean here, so the fixture carries one rather than letting
  // every asserted payload read `undefined`.
  onboardingDone: false,
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

  it('rejects the admin email with a wrong password', async () => {
    const { db } = makeFakeDb([[]]);
    const svc = new AuthService(db, config);
    await expect(svc.loginWithPassword('root@example.com', 'wrong')).rejects.toThrow(
      'Invalid credentials',
    );
  });

  // The environment password is this account's only credential, so a hash on
  // its row is not a second one. Such a hash can exist without anyone
  // planting it today: it may pre-date the rule that refuses to write one, or
  // belong to an ordinary account that only later became `ADMIN_EMAIL`. If it
  // still signed in, rotating `ADMIN_PASSWORD` would leave the old credential
  // working — precisely what refusing the write was meant to prevent.
  it('refuses a stored hash on the deployment admin row', async () => {
    const passwordHash = await hashPassword('planted-password');
    const { db } = makeFakeDb([[{ ...ROW, email: 'root@example.com', passwordHash }]]);
    const svc = new AuthService(db, config);
    await expect(svc.loginWithPassword('root@example.com', 'planted-password')).rejects.toThrow(
      'Invalid credentials',
    );
    // Never even read: the env credential is an alternative to the stored
    // one, not a first attempt that falls through to it.
    expect(vi.mocked(db.select)).not.toHaveBeenCalled();
  });

  // The refusal is a rule about this login, not a deletion of the row — which
  // is why it is safe. Hand the identity back to the app by unsetting
  // `ADMIN_PASSWORD` and its stored password works again, the same way
  // `isEnvAdmin` stops being reported.
  it('accepts that same stored hash once ADMIN_PASSWORD is unset', async () => {
    const passwordHash = await hashPassword('planted-password');
    const { db } = makeFakeDb([[{ ...ROW, email: 'root@example.com', passwordHash }]]);
    const svc = new AuthService(
      db,
      makeConfig({ adminEmail: 'root@example.com', adminPassword: '' }),
    );
    const result = await svc.loginWithPassword('root@example.com', 'planted-password');
    expect(result.user.email).toBe('root@example.com');
    expect(result.user.isEnvAdmin).toBe(false);
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

/**
 * The three kinds of account that reach the Account page's password change,
 * and what separates them.
 *
 * The reported bug was "an administrator cannot change their password", and
 * the first two cases pin down that ROLE is not the dividing line: the Admin
 * role lives in `roles.yaml` and is read by `IAdminAccessService` for the
 * admin routes — it never reaches this service, so an Admin-role account is
 * the same row as a business user's and takes byte-identical paths here. The
 * real divide is the DEPLOYMENT admin, whose password is in the environment.
 */
describe('AuthService.changePassword — the three account kinds', () => {
  const ENV_ADMIN = { adminEmail: 'root@example.com', adminPassword: 'sup3r-secret' };

  // (a) an Admin-role account and (b) a business user: same table, same code.
  // Parameterised deliberately — one body proves the two are not distinguished
  // rather than two bodies that could drift apart.
  for (const kind of [
    { label: 'an Admin-role account', email: 'admin-role@example.com', id: 'user-admin' },
    { label: 'a business user', email: 'bob@example.com', id: 'user-bob' },
  ]) {
    describe(kind.label, () => {
      const row = async () => ({
        ...ROW,
        id: kind.id,
        email: kind.email,
        passwordHash: await hashPassword('old-password'),
      });

      it('refuses a wrong current password', async () => {
        const { db } = makeFakeDb([[await row()]]);
        await expect(
          new AuthService(db, makeConfig(ENV_ADMIN)).changePassword(
            kind.id,
            'not-it',
            'new-password-1',
          ),
        ).rejects.toThrow('Current password is incorrect');
      });

      it('refuses an omitted current password once one is set', async () => {
        const { db } = makeFakeDb([[await row()]]);
        await expect(
          new AuthService(db, makeConfig(ENV_ADMIN)).changePassword(
            kind.id,
            undefined,
            'new-password-1',
          ),
        ).rejects.toThrow('Current password is incorrect');
      });

      it('applies the same password policy', async () => {
        const { db } = makeFakeDb([[await row()]]);
        await expect(
          new AuthService(db, makeConfig(ENV_ADMIN)).changePassword(kind.id, 'old-password', 'short'),
        ).rejects.toThrow(/at least/);
      });

      it('stores a new hash for the right current password', async () => {
        const { db, captured } = makeFakeDb([[await row()], undefined]);
        await new AuthService(db, makeConfig(ENV_ADMIN)).changePassword(
          kind.id,
          'old-password',
          'new-password-1',
        );
        const set = captured.set[0] as { passwordHash: string };
        expect(set.passwordHash.startsWith('scrypt:')).toBe(true);
        // The stored hash is the NEW password and no longer the old one, so
        // the next sign-in behaves the way the tester expected.
        expect(await verifyPassword('new-password-1', set.passwordHash)).toBe(true);
        expect(await verifyPassword('old-password', set.passwordHash)).toBe(false);
      });

      it('is not flagged as the deployment admin', async () => {
        const { db } = makeFakeDb([[await row()]]);
        const user = await new AuthService(db, makeConfig(ENV_ADMIN)).getUserById(kind.id);
        expect(user?.isEnvAdmin).toBe(false);
      });
    });
  }

  // (c) the deployment admin. Its password is the environment's, so a stored
  // hash would not replace it — it would ADD a credential that also signs in,
  // outlives rotating ADMIN_PASSWORD, and then makes every later attempt that
  // types the environment password as the current one fail against the stray
  // hash. Refused in the service, not only hidden on the page.
  describe('the deployment admin', () => {
    const rootRow = { ...ROW, id: 'user-root', email: 'root@example.com', passwordHash: null };

    it('is refused, and nothing is written', async () => {
      const { db, captured } = makeFakeDb([[rootRow], undefined]);
      await expect(
        new AuthService(db, makeConfig(ENV_ADMIN)).changePassword(
          'user-root',
          'sup3r-secret',
          'new-password-1',
        ),
      ).rejects.toThrow(/set in the deployment environment/);
      expect(captured.set).toHaveLength(0);
    });

    it('is refused without a current password too — the no-hash path no longer lets a session holder plant one', async () => {
      const { db, captured } = makeFakeDb([[rootRow], undefined]);
      await expect(
        new AuthService(db, makeConfig(ENV_ADMIN)).changePassword(
          'user-root',
          undefined,
          'new-password-1',
        ),
      ).rejects.toThrow(/cannot be changed here/);
      expect(captured.set).toHaveLength(0);
    });

    it('is refused even once a hash exists, and the refusal names the real reason', async () => {
      const passwordHash = await hashPassword('planted-password');
      const { db } = makeFakeDb([[{ ...rootRow, passwordHash }], undefined]);
      await expect(
        new AuthService(db, makeConfig(ENV_ADMIN)).changePassword(
          'user-root',
          'planted-password',
          'short',
        ),
        // Refused BEFORE the policy check: being sent to pick a longer password
        // would be a lie about why the change cannot happen.
      ).rejects.toThrow(/deployment environment/);
    });

    it('carries the flag to the client without any part of the credential', async () => {
      const { db } = makeFakeDb([[rootRow]]);
      const user = await new AuthService(db, makeConfig(ENV_ADMIN)).getUserById('user-root');
      expect(user?.isEnvAdmin).toBe(true);
      // The whole shape, pinned the way listAccounts pins its own: these keys
      // and no others, so a column added to `users` cannot reach the browser
      // by being spread in, and one that is dropped is noticed here.
      expect(Object.keys(user ?? {}).sort()).toEqual([
        'avatarUrl',
        'email',
        'id',
        'isEnvAdmin',
        'name',
        'onboardingDone',
      ]);
      expect(user?.onboardingDone).toBe(false);
      expect(JSON.stringify(user)).not.toContain('sup3r-secret');
    });

    // The Account page is not the only way to a stored hash: any admin can aim
    // "Set password" (POST /api/admin/accounts → createAccount) at this email.
    // A hash planted there would be exactly the second credential the
    // self-service refusal exists to prevent, so it is refused at the service.
    it("is refused an admin's Set password too, and nothing is written", async () => {
      const { db, captured } = makeFakeDb([[rootRow]]);
      await expect(
        new AuthService(db, makeConfig(ENV_ADMIN)).createAccount(
          // Canonicalised first: a differently-cased ADMIN_EMAIL is the same
          // identity and must not slip past the check.
          'Root@Example.com',
          'Root',
          'planted-password',
        ),
      ).rejects.toThrow(/set in the deployment environment/);
      expect(captured.values).toHaveLength(0);
      expect(captured.conflict).toHaveLength(0);
    });

    it("is refused before the policy check, so the admin is told the real reason", async () => {
      const { db } = makeFakeDb([[rootRow]]);
      await expect(
        new AuthService(db, makeConfig(ENV_ADMIN)).createAccount('root@example.com', 'Root', 'short'),
      ).rejects.toThrow(/deployment environment/);
    });

    it('takes an admin-set password again once ADMIN_PASSWORD is unset', async () => {
      const { db, captured } = makeFakeDb([[rootRow]]);
      await new AuthService(
        db,
        makeConfig({ adminEmail: 'root@example.com', adminPassword: '' }),
      ).createAccount('root@example.com', 'Root', 'ordinary-password');
      expect((captured.values[0] as { passwordHash: string }).passwordHash.startsWith('scrypt:')).toBe(
        true,
      );
    });

    it('is an ordinary account — form and all — while ADMIN_PASSWORD is unset', async () => {
      const passwordHash = await hashPassword('old-password');
      const config = makeConfig({ adminEmail: 'root@example.com', adminPassword: '' });
      const flagged = await new AuthService(
        makeFakeDb([[{ ...rootRow, passwordHash }]]).db,
        config,
      ).getUserById('user-root');
      expect(flagged?.isEnvAdmin).toBe(false);

      const { db, captured } = makeFakeDb([[{ ...rootRow, passwordHash }], undefined]);
      await new AuthService(db, config).changePassword('user-root', 'old-password', 'new-password-1');
      expect((captured.set[0] as { passwordHash: string }).passwordHash.startsWith('scrypt:')).toBe(
        true,
      );
    });
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

  it('marks the env admin with and without a stored hash, independently of hasPassword', async () => {
    const passwordHash = await hashPassword('pw-longer-than-8');
    const rows = [
      { ...ROW, id: 'root-hashed', email: 'root@example.com', passwordHash, createdAt: new Date() },
      { ...ROW, id: 'user-2', email: 'bob@example.com', passwordHash, createdAt: new Date() },
      { ...ROW, id: 'user-3', email: 'sso@example.com', passwordHash: null, createdAt: new Date() },
    ];
    const config = makeConfig({ adminEmail: 'root@example.com', adminPassword: 'sup3r-secret' });

    const withHash = await new AuthService(makeFakeDb([rows]).db, config).listAccounts();
    expect(withHash.map((a) => [a.email, a.hasPassword, a.isEnvAdmin])).toEqual([
      ['root@example.com', true, true],
      ['bob@example.com', true, false],
      ['sso@example.com', false, false],
    ]);

    const noHashRows = [{ ...rows[0], passwordHash: null }];
    const withoutHash = await new AuthService(makeFakeDb([noHashRows]).db, config).listAccounts();
    expect(withoutHash.map((a) => [a.hasPassword, a.isEnvAdmin])).toEqual([[false, true]]);

    // Neither the hash nor the environment password ever leaves the service.
    const json = JSON.stringify([...withHash, ...withoutHash]);
    expect(json).not.toContain('scrypt:');
    expect(json).not.toContain('sup3r-secret');
    for (const account of [...withHash, ...withoutHash]) {
      expect(Object.keys(account).sort()).toEqual(
        ['createdAt', 'email', 'hasPassword', 'id', 'isEnvAdmin', 'name'],
      );
    }
  });

  it('is not the env admin while ADMIN_PASSWORD is unset (SSO-only deployment)', async () => {
    const rows = [{ ...ROW, email: 'root@example.com', passwordHash: null, createdAt: new Date() }];
    const config = makeConfig({ adminEmail: 'root@example.com', adminPassword: '' });
    const accounts = await new AuthService(makeFakeDb([rows]).db, config).listAccounts();
    expect(accounts[0].isEnvAdmin).toBe(false);
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
