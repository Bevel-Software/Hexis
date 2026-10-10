import { describe, it, expect, beforeEach } from 'vitest';
import type { AuthUser } from '@bevel-software/platform-shared';
import type { Database } from '../../database/connection.js';
import { FileLockService } from '../file-lock.service.js';
import { WorkflowValidationError } from '../../../shared/domain-errors.js';
import { makeFakeLockDb, type FakeLockDb } from './fake-file-lock-db.js';

/**
 * A deletion runs its last "is any save landing?" check inside
 * `whileNoneAcquired`, and a save starts by taking its file lock. An acquire
 * that passed the gate before the deletion began, but whose row was still
 * being written, must be seen by that check — not land after it.
 */

const ALICE: AuthUser = { id: '11111111-1111-4111-8111-111111111111', email: 'alice@example.com', name: 'Alice' };
const WS = 'alice%2Fdraft';
const BRANCH = 'alice/draft';
const PATH = 'knowledge-base/a.md';

/** The fake lock db, with every INSERT held until `release()`. */
function withHeldInserts(fake: FakeLockDb): { db: Database; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const base = fake.db as unknown as { insert: () => { values: (row: unknown) => Record<string, unknown> } };
  const db = {
    ...base,
    insert: () => ({
      values: (row: unknown) => {
        const chain = base.insert().values(row) as {
          onConflictDoUpdate: (arg: unknown) => unknown;
          returning: () => Promise<unknown>;
        };
        const held = {
          onConflictDoUpdate: (arg: unknown) => {
            chain.onConflictDoUpdate(arg);
            return held;
          },
          returning: async () => {
            await gate;
            return chain.returning();
          },
        };
        return held;
      },
    }),
  } as unknown as Database;
  return { db, release };
}

describe('FileLockService deletion gate', () => {
  let fake: FakeLockDb;

  beforeEach(() => {
    fake = makeFakeLockDb();
  });

  it('waits for an acquire already under way, so the check inside sees its lock', async () => {
    const { db, release } = withHeldInserts(fake);
    const locks = new FileLockService(db);

    const acquire = locks.acquire(WS, BRANCH, PATH, ALICE);
    let sawLock: boolean | null = null;
    const deletion = locks.whileNoneAcquired(BRANCH, async () => {
      sawLock = await locks.hasAnyActive(WS);
    });

    await new Promise((r) => setTimeout(r, 10));
    // The acquire's row is not written yet, so the check has not run.
    expect(sawLock).toBeNull();

    release();
    await expect(acquire).resolves.toMatchObject({ acquired: true });
    await deletion;
    expect(sawLock).toBe(true);
  });

  it('refuses an acquire that starts while the deletion runs', async () => {
    const locks = new FileLockService(fake.db);
    let refused: unknown = null;
    await locks.whileNoneAcquired(BRANCH, async () => {
      refused = await locks.acquire(WS, BRANCH, PATH, ALICE).catch((err: unknown) => err);
    });
    expect(refused).toBeInstanceOf(WorkflowValidationError);
    expect(fake.rows()).toHaveLength(0);
    // And grants it again once the deletion is over.
    await expect(locks.acquire(WS, BRANCH, PATH, ALICE)).resolves.toMatchObject({ acquired: true });
  });

  it('does not wait for an acquire on another branch', async () => {
    const { db, release } = withHeldInserts(fake);
    const locks = new FileLockService(db);

    const other = locks.acquire('bob%2Fdraft', 'bob/draft', PATH, ALICE);
    let ran = false;
    await locks.whileNoneAcquired(BRANCH, async () => {
      ran = true;
    });
    expect(ran).toBe(true);
    release();
    await other;
  });
});
