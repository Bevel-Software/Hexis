import { describe, expect, it, vi } from 'vitest';
import { PendingCommitsService } from '../pending-commits.service.js';
import type { Database } from '../../database/connection.js';

/**
 * `enqueueIfAbsent` backs the pull-conflict recovery dispatch: it must
 * insert only when NO row exists for the (workspace, branch, path) in ANY
 * status. A plain `enqueue` would refresh an existing pending row and reset
 * its retry counters — and the dispatch path fires on every sync attempt,
 * so those resets would starve the worker's ladder and the recovery agent
 * would never spawn. A `needs_attention` row must also block re-entry (the
 * ladder already escalated to a human; more agent runs are just a loop).
 *
 * Fake drizzle chain, same shape as the vault tests — the queue's SQL-level
 * behavior (claim fencing etc.) is covered elsewhere; this pins the
 * check-then-insert decision logic.
 */
function makeFakeDb(existingCount: number) {
  const inserted: unknown[] = [];
  const selectChain: any = {};
  selectChain.from = vi.fn(() => selectChain);
  selectChain.where = vi.fn(() => selectChain);
  selectChain.then = (onF: any, onR: any) =>
    Promise.resolve([{ count: existingCount }]).then(onF, onR);
  const insertChain: any = {};
  insertChain.values = vi.fn((v: unknown) => {
    inserted.push(v);
    return insertChain;
  });
  insertChain.then = (onF: any, onR: any) => Promise.resolve(undefined).then(onF, onR);
  const db = {
    select: vi.fn(() => selectChain),
    insert: vi.fn(() => insertChain),
  } as unknown as Database;
  return { db, inserted };
}

const INPUT = {
  workspaceId: 'razvan.radulescu/feature',
  branch: 'razvan.radulescu/feature',
  path: 'PR-Overviews/PR-7.html',
  authorEmail: 'Alice@Example.com',
  authorName: 'Alice',
};

describe('PendingCommitsService.enqueueIfAbsent', () => {
  it('inserts (canonical workspace id, lowercased email) when no row exists', async () => {
    const { db, inserted } = makeFakeDb(0);
    const svc = new PendingCommitsService(db);

    await expect(svc.enqueueIfAbsent(INPUT)).resolves.toBe(true);

    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      // Same canonicalization as `enqueue` — the worker claims per the
      // ENCODED `knownWorkspaces()` id, so a decoded id would never drain.
      workspaceId: 'razvan.radulescu%2Ffeature',
      branch: 'razvan.radulescu/feature',
      path: 'PR-Overviews/PR-7.html',
      authorEmail: 'alice@example.com',
      authorName: 'Alice',
    });
  });

  it('is a no-op when ANY row exists for the tuple (pending, running, or needs_attention)', async () => {
    const { db, inserted } = makeFakeDb(1);
    const svc = new PendingCommitsService(db);

    await expect(svc.enqueueIfAbsent(INPUT)).resolves.toBe(false);
    expect(inserted).toHaveLength(0);
  });
});
