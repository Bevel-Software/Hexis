import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { Database } from '../../database/connection.js';
import type { CoreConfig } from '../../../core-config.js';
import { AuthService } from '../auth.service.js';
import {
  AccountAdmissionRefusedError,
  AccountChangeRefusedError,
  AccountDeactivatedError,
  AuthBackendError,
  type AccountProvisionReason,
  type IAccountAdmission,
} from '../account-admission.js';
import { hashPassword } from '../password-hash.js';
import { RECOVERY_BOT_EMAIL } from '../../workflow/recovery-bot.js';

/**
 * Drizzle chain stub, as in `auth.service.test.ts`: each db.select() /
 * insert() / update() consumes the next queued result; awaiting any point of
 * the chain resolves it. Records what was inserted and set, and the order of
 * the switch lock (`execute`) against the writes.
 */
function makeFakeDb(queue: unknown[]) {
  const captured: { values: Record<string, unknown>[]; set: Record<string, unknown>[]; order: string[] } = {
    values: [],
    set: [],
    order: [],
  };
  const dialect = new PgDialect();
  function nextChain(): unknown {
    const result = queue.shift();
    const chain: Record<string, unknown> = {};
    const passthrough = (recorder?: (arg: Record<string, unknown>) => void) =>
      vi.fn((arg?: unknown) => {
        recorder?.(arg as Record<string, unknown>);
        return chain;
      });
    Object.assign(chain, {
      values: passthrough((a) => captured.values.push(a)),
      set: passthrough((a) => captured.set.push(a)),
      where: passthrough(),
      limit: passthrough(),
      from: passthrough(),
      orderBy: passthrough(),
      returning: passthrough(),
      onConflictDoUpdate: passthrough(),
      onConflictDoNothing: passthrough(),
      then: (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) => Promise.resolve(result).then(ok, ko),
    });
    return chain;
  }
  const db = {
    insert: vi.fn(() => (captured.order.push('insert'), nextChain())),
    select: vi.fn(() => nextChain()),
    update: vi.fn(() => (captured.order.push('update'), nextChain())),
    execute: vi.fn(async (query: SQL) => {
      const { sql, params } = dialect.sqlToQuery(query);
      captured.order.push(`${sql} ${JSON.stringify(params)}`);
      return [];
    }),
    transaction: async <T,>(cb: (tx: unknown) => Promise<T>) => cb(db),
  };
  return { db: db as unknown as Database, captured };
}

function makeConfig(over: Partial<CoreConfig> = {}): CoreConfig {
  return { jwtSecret: 'test-jwt-secret', adminEmail: '', adminPassword: '', allowedEmailDomains: [], ...over } as CoreConfig;
}

const ROW = { id: 'user-1', email: 'alice@example.com', name: 'Alice', avatarUrl: null, onboardingDone: false, deactivatedAt: null };
const OFF = { ...ROW, deactivatedAt: new Date('2026-09-01') };

function recordingPort(verdict: Awaited<ReturnType<IAccountAdmission['canProvision']>>) {
  const asked: Array<[string, AccountProvisionReason]> = [];
  const port: IAccountAdmission = {
    canProvision: async (email, reason) => {
      asked.push([email, reason]);
      return verdict;
    },
  };
  return { port, asked };
}

describe('signing in with a switched-off account', () => {
  it('refuses a password sign-in once the password is proven, and says why', async () => {
    const passwordHash = await hashPassword('a-long-enough-password');
    const { db } = makeFakeDb([[{ ...OFF, passwordHash }]]);
    const svc = new AuthService(db, makeConfig());
    await expect(svc.loginWithPassword('alice@example.com', 'a-long-enough-password')).rejects.toBeInstanceOf(
      AccountDeactivatedError,
    );
  });

  it('gives a wrong password the same answer as for any account, so it reveals nothing', async () => {
    const passwordHash = await hashPassword('a-long-enough-password');
    const { db } = makeFakeDb([[{ ...OFF, passwordHash }]]);
    const svc = new AuthService(db, makeConfig());
    await expect(svc.loginWithPassword('alice@example.com', 'the-wrong-password')).rejects.toThrow('Invalid credentials');
  });

  it('refuses a single sign-on sign-in, without issuing a session', async () => {
    const { db } = makeFakeDb([[OFF]]);
    const svc = new AuthService(db, makeConfig());
    await expect(svc.loginWithSso('alice@example.com', 'Alice')).rejects.toBeInstanceOf(AccountDeactivatedError);
  });

  it('refuses an embed identity', async () => {
    const { db } = makeFakeDb([[OFF]]);
    const svc = new AuthService(db, makeConfig());
    await expect(svc.getOrCreateByEmail('alice@example.com')).rejects.toBeInstanceOf(AccountDeactivatedError);
  });
});

describe('a session that outlives a deactivation', () => {
  it('stops being accepted once the account is switched off', async () => {
    const { db } = makeFakeDb([[ROW], [{ deactivatedAt: new Date() }]]);
    const svc = new AuthService(db, makeConfig());
    const { token } = await svc.loginWithSso('alice@example.com', 'Alice');
    // The signature alone is still good…
    expect(svc.verifyToken(token).userId).toBe(ROW.id);
    // …but the session is not.
    await expect(svc.resolveSession(token)).rejects.toBeInstanceOf(AccountDeactivatedError);
  });

  it('is told apart from a refusal when the account cannot be looked up', async () => {
    const { db } = makeFakeDb([[ROW]]);
    const svc = new AuthService(db, makeConfig());
    const { token } = await svc.loginWithSso('alice@example.com', 'Alice');
    vi.mocked(db.select).mockImplementationOnce(() => {
      throw new Error('db down');
    });
    await expect(svc.resolveSession(token)).rejects.toBeInstanceOf(AuthBackendError);
  });

  it('is accepted while the account is on', async () => {
    const { db } = makeFakeDb([[ROW], [{ deactivatedAt: null }]]);
    const svc = new AuthService(db, makeConfig());
    const { token } = await svc.loginWithSso('alice@example.com', 'Alice');
    await expect(svc.resolveSession(token)).resolves.toEqual({ userId: ROW.id, email: ROW.email });
  });
});

describe('AuthService.isActive', () => {
  it('reads once and keeps the answer briefly', async () => {
    const { db } = makeFakeDb([[{ deactivatedAt: null }]]);
    const svc = new AuthService(db, makeConfig());
    expect(await svc.isActive('user-1')).toBe(true);
    expect(await svc.isActive('user-1')).toBe(true);
    expect(vi.mocked(db.select)).toHaveBeenCalledTimes(1);
  });

  it('treats the deployment admin as on whatever its row says, so its rescue session works', async () => {
    const config = makeConfig({ adminEmail: 'root@example.com', adminPassword: 'sup3r-secret' });
    const { db } = makeFakeDb([[{ email: 'root@example.com', deactivatedAt: new Date() }]]);
    expect(await new AuthService(db, config).isActive('root-id')).toBe(true);
  });

  it('treats an account that no longer exists as off', async () => {
    const { db } = makeFakeDb([[]]);
    expect(await new AuthService(db, makeConfig()).isActive('gone')).toBe(false);
  });

  it('forgets the cached answer when this process switches the account off', async () => {
    const { db } = makeFakeDb([[{ deactivatedAt: null }], [ROW], [], [{ deactivatedAt: new Date() }]]);
    const svc = new AuthService(db, makeConfig());
    expect(await svc.isActive(ROW.id)).toBe(true);
    expect(await svc.deactivate(ROW.id)).toBe(true);
    expect(await svc.isActive(ROW.id)).toBe(false);
  });
});

describe('AuthService.deactivate', () => {
  it('records when the account was switched off', async () => {
    const { db, captured } = makeFakeDb([[ROW], []]);
    expect(await new AuthService(db, makeConfig()).deactivate(ROW.id)).toBe(true);
    expect(captured.set[0].deactivatedAt).toBeInstanceOf(Date);
  });

  it('switches off under the address switch lock, taken before the update', async () => {
    const { db, captured } = makeFakeDb([[{ ...ROW, email: 'Alice@Example.com' }], []]);
    await new AuthService(db, makeConfig()).deactivate(ROW.id);
    expect(captured.order).toEqual([
      'select pg_advisory_xact_lock(hashtext($1)) ["account-switch:alice@example.com"]',
      'update',
    ]);
  });

  it('answers false for an account that does not exist', async () => {
    const { db } = makeFakeDb([[]]);
    expect(await new AuthService(db, makeConfig()).deactivate('nobody')).toBe(false);
  });

  it('refuses the deployment admin, whose environment password is the way back in', async () => {
    const config = makeConfig({ adminEmail: 'root@example.com', adminPassword: 'sup3r-secret' });
    const { db } = makeFakeDb([[{ ...ROW, email: 'root@example.com' }]]);
    await expect(new AuthService(db, config).deactivate(ROW.id)).rejects.toBeInstanceOf(AccountChangeRefusedError);
    expect(vi.mocked(db.update)).not.toHaveBeenCalled();
  });

  it('refuses the accounts the platform runs its own work as', async () => {
    const { db } = makeFakeDb([[{ ...ROW, email: RECOVERY_BOT_EMAIL }]]);
    await expect(new AuthService(db, makeConfig()).deactivate(ROW.id)).rejects.toThrow('platform itself');
    expect(vi.mocked(db.update)).not.toHaveBeenCalled();
  });
});

describe('AuthService.reactivate', () => {
  it('asks the admission port, as for a new account, and switches it on when admitted', async () => {
    const { port, asked } = recordingPort({ ok: true });
    const { db, captured } = makeFakeDb([[OFF], []]);
    expect(await new AuthService(db, makeConfig(), port).reactivate(ROW.id)).toBe(true);
    expect(asked).toEqual([['alice@example.com', 'reactivate']]);
    expect(captured.set[0].deactivatedAt).toBeNull();
  });

  it("refuses with the port's words when there is no room, and changes nothing", async () => {
    const { port } = recordingPort({ ok: false, message: 'All 3 seats are taken' });
    const { db } = makeFakeDb([[OFF]]);
    const svc = new AuthService(db, makeConfig(), port);
    await expect(svc.reactivate(ROW.id)).rejects.toThrow('All 3 seats are taken');
    expect(vi.mocked(db.update)).not.toHaveBeenCalled();
  });

  it('does not ask about an account that is already on', async () => {
    const { port, asked } = recordingPort({ ok: false, message: 'full' });
    const { db } = makeFakeDb([[ROW]]);
    expect(await new AuthService(db, makeConfig(), port).reactivate(ROW.id)).toBe(true);
    expect(asked).toEqual([]);
  });
});

describe('a first sign-in the port would rather keep waiting', () => {
  const waiting = { ok: false as const, message: 'No seat left; the admin can let you in', waitForAdmin: true };

  it('puts the person on file switched off, and still refuses the sign-in', async () => {
    const { port } = recordingPort(waiting);
    const { db, captured } = makeFakeDb([[], []]);
    const svc = new AuthService(db, makeConfig(), port);
    const err = await svc.loginWithSso('new@example.com', 'New').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AccountAdmissionRefusedError);
    expect((err as AccountAdmissionRefusedError).waitingForAdmin).toBe(true);
    expect((err as Error).message).toBe(waiting.message);
    expect(captured.values).toHaveLength(1);
    expect(captured.values[0]).toMatchObject({ email: 'new@example.com' });
    expect(captured.values[0].deactivatedAt).toBeInstanceOf(Date);
    // Created switched off, so under the address's switch lock.
    expect(captured.order).toEqual([
      'select pg_advisory_xact_lock(hashtext($1)) ["account-switch:new@example.com"]',
      'insert',
    ]);
  });

  it('is a plain refusal when an admin creates the account', async () => {
    const { port } = recordingPort(waiting);
    const { db } = makeFakeDb([[]]);
    const err = await new AuthService(db, makeConfig(), port)
      .createAccount('new@example.com', 'New')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AccountAdmissionRefusedError);
    expect((err as AccountAdmissionRefusedError).waitingForAdmin).toBe(false);
    expect(vi.mocked(db.insert)).not.toHaveBeenCalled();
  });
});

describe('AuthService.createAccount without a password', () => {
  it('makes an account for single sign-on, with no hash stored', async () => {
    const { db, captured } = makeFakeDb([[{ ...ROW, passwordHash: null }]]);
    const user = await new AuthService(db, makeConfig()).createAccount('Alice@Example.com', '');
    expect(user.email).toBe('alice@example.com');
    // The index column is written with the address; the handle indexes it.
    expect(captured.values[0]).toEqual({ email: 'alice@example.com', emailBidx: 'alice@example.com', name: 'alice' });
  });

  it('asks the admission port, as any new account does', async () => {
    const { port, asked } = recordingPort({ ok: true });
    const { db } = makeFakeDb([[], [{ ...ROW, passwordHash: null }]]);
    await new AuthService(db, makeConfig(), port).createAccount('alice@example.com', 'Alice');
    expect(asked).toEqual([['alice@example.com', 'admin-create']]);
  });
});
