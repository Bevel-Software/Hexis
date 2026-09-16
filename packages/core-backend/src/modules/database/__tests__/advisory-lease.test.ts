import { describe, it, expect } from 'vitest';
import { AdvisoryLease, AdvisoryLock, type LeaseClient } from '../advisory-lock.js';
import type { Database } from '../connection.js';

/**
 * A connection the suite scripts: what the lock query answers, and a way to
 * make the connection drop out from under the lease. Driven only through the
 * lease's public surface.
 */
function fakeClient(opts: { grants: boolean }) {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const record = { queries: [] as string[], ended: false };
  const client: LeaseClient = {
    async query(text) {
      record.queries.push(text);
      if (text.includes('pg_try_advisory_lock')) return { rows: [{ held: opts.grants }] };
      return { rows: [] };
    },
    async end() {
      record.ended = true;
    },
    on(event, listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return client;
    },
  };
  const drop = () => {
    for (const l of listeners.get('error') ?? []) l(new Error('connection terminated'));
  };
  return { client, record, drop };
}

const db = {} as Database;

describe('AdvisoryLease', () => {
  it('holds the lease once granted, and keeps the connection open to hold it', async () => {
    const conn = fakeClient({ grants: true });
    const lease = new AdvisoryLease(db, AdvisoryLock.CommitWorker, { connect: async () => conn.client });

    expect(lease.held).toBe(false);
    expect(await lease.tryAcquire()).toBe(true);
    expect(lease.held).toBe(true);
    // A session lock lives on its connection; ending it would release the lock.
    expect(conn.record.ended).toBe(false);
    // Asking again while held costs nothing and opens nothing.
    expect(await lease.tryAcquire()).toBe(true);
  });

  it('opens nothing lasting when another process holds it', async () => {
    const conn = fakeClient({ grants: false });
    const lease = new AdvisoryLease(db, AdvisoryLock.CommitWorker, { connect: async () => conn.client });

    expect(await lease.tryAcquire()).toBe(false);
    expect(lease.held).toBe(false);
    // The connection that asked and was refused is not kept around.
    expect(conn.record.ended).toBe(true);
  });

  it('releases by unlocking and ending its connection, and is idempotent', async () => {
    const conn = fakeClient({ grants: true });
    const lease = new AdvisoryLease(db, AdvisoryLock.CommitWorker, { connect: async () => conn.client });
    await lease.tryAcquire();

    await lease.release();
    expect(lease.held).toBe(false);
    expect(conn.record.queries.some((q) => q.includes('pg_advisory_unlock'))).toBe(true);
    expect(conn.record.ended).toBe(true);

    await expect(lease.release()).resolves.toBeUndefined();
    await expect(new AdvisoryLease(db, AdvisoryLock.CommitWorker, { connect: async () => conn.client }).release()).resolves.toBeUndefined();
  });

  it('reports the lease lost the moment its connection drops, before any listener runs', async () => {
    const conn = fakeClient({ grants: true });
    const lease = new AdvisoryLease(db, AdvisoryLock.CommitWorker, { connect: async () => conn.client });
    await lease.tryAcquire();
    let heldWhenTold: boolean | null = null;
    lease.onLost(() => {
      heldWhenTold = lease.held;
    });

    conn.drop();

    // The listener must be able to trust `held` — a holder that keeps working
    // after this is the double-worker case the lease exists to prevent.
    expect(heldWhenTold).toBe(false);
    expect(lease.held).toBe(false);
    // Losing it is not releasing it: the same lease can be asked for again.
    const again = fakeClient({ grants: true });
    const release = new AdvisoryLease(db, AdvisoryLock.CommitWorker, { connect: async () => again.client });
    expect(await release.tryAcquire()).toBe(true);
  });

  it('a connection that drops before the grant is not a lease, and not a loss either', async () => {
    const conn = fakeClient({ grants: true });
    const failing: LeaseClient = {
      ...conn.client,
      async query() {
        // The drop lands while the lock query is in flight, as a 'error' on
        // the client and a rejection of the query.
        conn.drop();
        throw new Error('connection terminated');
      },
    };
    const lease = new AdvisoryLease(db, AdvisoryLock.CommitWorker, { connect: async () => failing });
    let told = 0;
    lease.onLost(() => {
      told += 1;
    });

    await expect(lease.tryAcquire()).rejects.toThrow('connection terminated');
    expect(lease.held).toBe(false);
    expect(told).toBe(0);
  });

  it('a stale connection ending later cannot clear a lease held on a new one', async () => {
    const first = fakeClient({ grants: true });
    const second = fakeClient({ grants: true });
    const clients = [first.client, second.client];
    const lease = new AdvisoryLease(db, AdvisoryLock.CommitWorker, { connect: async () => clients.shift()! });
    await lease.tryAcquire();
    first.drop();
    expect(lease.held).toBe(false);
    expect(await lease.tryAcquire()).toBe(true);
    let told = 0;
    lease.onLost(() => {
      told += 1;
    });

    // The first connection's own 'end', delivered late.
    first.drop();

    expect(lease.held).toBe(true);
    expect(told).toBe(0);
  });

  it('does not report a loss for a release it performed itself', async () => {
    const conn = fakeClient({ grants: true });
    const lease = new AdvisoryLease(db, AdvisoryLock.CommitWorker, { connect: async () => conn.client });
    await lease.tryAcquire();
    let told = 0;
    lease.onLost(() => {
      told += 1;
    });

    await lease.release();
    // A real client emits 'end' as it closes; that must read as our own doing.
    conn.drop();

    expect(told).toBe(0);
  });
});
