import { describe, it, expect } from 'vitest';
import { AdvisoryLock, withAdvisoryLock } from '../advisory-lock.js';
import type { Database } from '../connection.js';

/**
 * A pool whose connections record what was asked of them. The SQL a lock
 * issues IS its observable behaviour — there is nothing else to see from
 * outside — so these suites drive `withAdvisoryLock` with a crafted pool and
 * read back the statements and the release.
 */
interface RecordedClient {
  queries: string[];
  released: boolean;
  releasedWith: Error | undefined;
}

function fakePool(opts: { failOn?: (sql: string) => Error } = {}) {
  const clients: RecordedClient[] = [];
  const pool = {
    async connect() {
      const record: RecordedClient = { queries: [], released: false, releasedWith: undefined };
      clients.push(record);
      return {
        async query(sql: string) {
          record.queries.push(sql);
          const failure = opts.failOn?.(sql);
          if (failure) throw failure;
          return { rows: [] };
        },
        release(err?: Error) {
          record.released = true;
          record.releasedWith = err;
        },
      };
    },
  };
  return { clients, db: { $client: pool } as unknown as Database };
}

/** The error shape `pg` raises when `lock_timeout` expires. */
function lockTimeoutError(): Error {
  return Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
}

describe('withAdvisoryLock', () => {
  it('holds the lock across the callback and releases it by ending the transaction', async () => {
    const { clients, db } = fakePool();
    let queriesWhenBodyRan: string[] = [];

    const result = await withAdvisoryLock(db, AdvisoryLock.CoreMigrations, async () => {
      queriesWhenBodyRan = [...clients[0].queries];
      return 'migrated';
    });

    expect(result).toBe('migrated');
    // The lock is taken before the body starts...
    expect(queriesWhenBodyRan.some((q) => q.includes('pg_advisory_xact_lock'))).toBe(true);
    expect(queriesWhenBodyRan).not.toContain('rollback');
    // ...and the transaction that holds it ends after the body, which is what
    // releases both the lock and the transaction-local lock_timeout.
    expect(clients[0].queries.at(-1)).toBe('rollback');
    expect(clients[0].released).toBe(true);
    expect(clients[0].releasedWith).toBeUndefined();
  });

  it('bounds the wait rather than blocking the boot forever', async () => {
    const { clients, db } = fakePool();

    await withAdvisoryLock(db, AdvisoryLock.CoreMigrations, async () => undefined, { waitMs: 1234 });

    // Transaction-local, so the setting leaves with the transaction and the
    // connection goes back to the pool as it arrived.
    const setTimeoutCall = clients[0].queries.find((q) => q.includes('set_config'));
    expect(setTimeoutCall).toContain('lock_timeout');
    expect(setTimeoutCall).toContain('true');
  });

  it('releases the lock when the callback throws, and propagates the failure', async () => {
    const { clients, db } = fakePool();
    const boom = new Error('migration 0004 failed');

    await expect(
      withAdvisoryLock(db, AdvisoryLock.CoreMigrations, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);

    expect(clients[0].queries.at(-1)).toBe('rollback');
    expect(clients[0].released).toBe(true);
  });

  it('never runs the callback when the lock cannot be taken in time', async () => {
    const { clients, db } = fakePool({
      failOn: (sql) => (sql.includes('pg_advisory_xact_lock') ? lockTimeoutError() : undefined!),
    });
    let ran = false;

    await expect(
      withAdvisoryLock(db, AdvisoryLock.EnterpriseMigrations, async () => {
        ran = true;
      }),
    ).rejects.toThrow(/EnterpriseMigrations advisory lock/);

    expect(ran).toBe(false);
    // Still cleaned up: a failed acquire leaves an open transaction behind
    // otherwise, and the connection would carry it back into the pool.
    expect(clients[0].queries.at(-1)).toBe('rollback');
    expect(clients[0].released).toBe(true);
  });

  it('destroys a connection it could not roll back instead of pooling it', async () => {
    const { clients, db } = fakePool({
      failOn: (sql) => (sql === 'rollback' ? new Error('connection terminated') : undefined!),
    });

    await withAdvisoryLock(db, AdvisoryLock.CoreMigrations, async () => undefined);

    // Releasing with an error is how `pg` is told to discard the connection.
    // Ending its session is also what actually releases a lock we may still
    // be holding, so this path is the fallback for the rollback itself failing.
    expect(clients[0].released).toBe(true);
    expect(clients[0].releasedWith).toBeInstanceOf(Error);
  });
});
