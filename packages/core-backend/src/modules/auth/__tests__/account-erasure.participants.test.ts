import { describe, expect, it } from 'vitest';
import { AccountErasureService, type IErasureParticipant } from '../account-erasure.service.js';
import type { Database } from '../../database/index.js';

/**
 * Whose slices an erasure runs, and in what order: core's own first (the
 * vault's managed sign-ins, say), then the distribution's, read from the
 * port's array as it IS at erasure time. The array is the root's and is held
 * by reference (`CorePorts.erasureParticipants`): a root may fill it after
 * construction, and core never writes into it — a root building a second
 * graph over the same array must not inherit the first graph's slices.
 */

/** A database that answers the one read erasure makes and swallows every write, outside the transaction and in it. */
function silentDb(): Database {
  const done = Promise.resolve([]);
  const tx = {
    execute: async () => ({ rows: [] }),
    select: () => ({ from: () => ({ where: async () => [] }) }),
    delete: () => ({ where: () => done }),
    update: () => ({ set: () => ({ where: () => done }) }),
  };
  return {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => [{ id: 'u1', email: 'bob@bevel.software', name: 'Bob' }] }),
      }),
    }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
    transaction: async <T,>(fn: (t: typeof tx) => Promise<T>) => fn(tx),
  } as unknown as Database;
}

describe('AccountErasureService: whose slices run, and in what order', () => {
  it('runs core’s own slices first, then the port’s array as it is at erasure time — the array held, never copied', async () => {
    const steps: string[] = [];
    const slice = (name: string): IErasureParticipant => ({
      before: async () => {
        steps.push(`before:${name}`);
      },
      inTransaction: async () => {
        steps.push(`tx:${name}`);
      },
    });
    // The port's array, as a root hands it over: one slice now …
    const fromPort = [slice('distribution-1')];
    const svc = new AccountErasureService(silentDb(), { eraseApprover: async () => undefined }, fromPort, [slice('vault')]);
    // … and one it appends AFTER construction. Core's slice is not in that
    // array, so the array holds exactly what the root put there.
    fromPort.push(slice('distribution-2'));
    expect(fromPort).toHaveLength(2);

    await expect(svc.eraseUser('u1')).resolves.toBe(true);
    expect(steps).toEqual(['before:vault', 'before:distribution-1', 'before:distribution-2', 'tx:vault', 'tx:distribution-1', 'tx:distribution-2']);
  });
});
