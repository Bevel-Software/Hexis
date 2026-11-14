import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { VersionControlDomainError } from '../../../shared/domain-errors.js';
import { ACCOUNT_BUSY_MESSAGE, ACCOUNT_SWITCH_LOCK_WAIT_MS, takeAccountSwitchLock } from '../account-switch-lock.js';

/** A transaction handle that records what it ran, and fails the lock statement when told to. */
function fakeTx(failLockWith?: { code: string; message: string }) {
  const dialect = new PgDialect();
  const ran: string[] = [];
  const execute = vi.fn(async (query: SQL) => {
    const { sql, params } = dialect.sqlToQuery(query);
    ran.push(`${sql} ${JSON.stringify(params)}`);
    if (failLockWith && sql.includes('pg_advisory_xact_lock')) {
      throw Object.assign(new Error(failLockWith.message), { code: failLockWith.code });
    }
    return [];
  });
  return { tx: { execute }, ran };
}

describe('takeAccountSwitchLock', () => {
  it('bounds the wait with a transaction-local lock_timeout, set before the lock is asked for', async () => {
    const { tx, ran } = fakeTx();
    await takeAccountSwitchLock(tx, 'Alice@Example.com');
    expect(ran).toEqual([
      `select set_config('lock_timeout', $1, true) ["${ACCOUNT_SWITCH_LOCK_WAIT_MS}"]`,
      'select pg_advisory_xact_lock(hashtext($1)) ["account-switch:alice@example.com"]',
    ]);
  });

  it('answers a wait that ran out as a 409 account-busy, in the words the admin is told', async () => {
    const { tx } = fakeTx({ code: '55P03', message: 'canceling statement due to lock timeout' });
    const refusal = takeAccountSwitchLock(tx, 'alice@example.com');
    await expect(refusal).rejects.toBeInstanceOf(VersionControlDomainError);
    await expect(refusal).rejects.toMatchObject({ status: 409, message: ACCOUNT_BUSY_MESSAGE, payload: { kind: 'account-busy' } });
  });

  it('lets any other failure of the lock through unchanged', async () => {
    const { tx } = fakeTx({ code: '57P01', message: 'terminating connection due to administrator command' });
    await expect(takeAccountSwitchLock(tx, 'alice@example.com')).rejects.toThrow('terminating connection');
  });
});
