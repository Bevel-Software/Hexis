import { describe, it, expect, beforeEach } from 'vitest';
import type { AuthUser } from '@bevel-software/platform-shared';
import { FileLockService } from '../file-lock.service.js';
import { PathTraversalError, WorkflowValidationError } from '../../../shared/domain-errors.js';
import { makeFakeLockDb, type FakeLockDb } from './fake-file-lock-db.js';

/**
 * A lock is only a lock if everyone agrees what it is on. `x/a.md`,
 * `./x/a.md` and `x//a.md` are three spellings of one file, and before this
 * each one took a row of its own: two editors could hold "the" lock on the
 * same file at the same time and overwrite each other, and a release could
 * find nothing to release.
 *
 * These tests drive the SERVICE, not the routes, on purpose. The routes are
 * one caller among several (the agent's lock-aware filesystem and the roles
 * admin reach the service directly), so the identity has to be decided at the
 * row, where the coordination happens.
 */

const ALICE: AuthUser = { id: '11111111-1111-4111-8111-111111111111', email: 'alice@example.com', name: 'Alice' };
const BOB: AuthUser = { id: '22222222-2222-4222-8222-222222222222', email: 'bob@example.com', name: 'Bob' };

const WS = 'feat%2Fx';
const BRANCH = 'feat/x';
const CANONICAL = 'knowledge-base/x/a.md';
/** Spellings of CANONICAL: a leading `./`, a doubled separator, and both. */
const SPELLINGS = [
  './knowledge-base/x/a.md',
  'knowledge-base//x/a.md',
  './knowledge-base//x//a.md',
];

describe('FileLockService coordinates on one canonical path', () => {
  let fake: FakeLockDb;
  let locks: FileLockService;

  beforeEach(() => {
    fake = makeFakeLockDb();
    locks = new FileLockService(fake.db);
  });

  it('stores the canonical spelling even when only a raw one was ever passed', async () => {
    // The direct-service case: nothing above canonicalised for us here.
    const result = await locks.acquire(WS, BRANCH, './knowledge-base//x//a.md', ALICE);

    expect(result.acquired).toBe(true);
    expect(result.lock.path).toBe(CANONICAL);
    expect(fake.rows().map((r) => r.path)).toEqual([CANONICAL]);
  });

  it.each(SPELLINGS)('a lock taken as %s refuses a second acquire spelled canonically', async (spelling) => {
    const first = await locks.acquire(WS, BRANCH, spelling, ALICE);
    expect(first.acquired).toBe(true);

    const second = await locks.acquire(WS, BRANCH, CANONICAL, BOB);

    // Refused exactly as a same-spelling re-acquire would be: not acquired,
    // and the holder comes back so the UI can say who has it.
    expect(second.acquired).toBe(false);
    expect(second.lock.holderUserId).toBe(ALICE.id);
    expect(second.lock.path).toBe(CANONICAL);
    // ONE lock, not two.
    expect(fake.rows()).toHaveLength(1);
  });

  it('refuses the same way when the same spelling is used twice (control)', async () => {
    await locks.acquire(WS, BRANCH, CANONICAL, ALICE);
    const second = await locks.acquire(WS, BRANCH, CANONICAL, BOB);

    expect(second.acquired).toBe(false);
    expect(second.lock.holderUserId).toBe(ALICE.id);
    expect(fake.rows()).toHaveLength(1);
  });

  it('holds one lock across the branch boundary only (same path, other branch is free)', async () => {
    await locks.acquire(WS, BRANCH, './knowledge-base//x/a.md', ALICE);
    const other = await locks.acquire('other%2Fy', 'other/y', CANONICAL, BOB);

    expect(other.acquired).toBe(true);
    expect(fake.rows()).toHaveLength(2);
  });

  it.each(SPELLINGS)('heartbeats a canonically-taken lock spelled as %s', async (spelling) => {
    const acquired = await locks.acquire(WS, BRANCH, CANONICAL, ALICE);

    const beat = await locks.heartbeat(WS, BRANCH, spelling, ALICE);

    expect(beat.path).toBe(CANONICAL);
    expect(beat.holderUserId).toBe(ALICE.id);
    expect(new Date(beat.expiresAt).getTime()).toBeGreaterThanOrEqual(
      new Date(acquired.lock.expiresAt).getTime(),
    );
    expect(fake.rows()).toHaveLength(1);
  });

  it.each(SPELLINGS)('releases a canonically-taken lock spelled as %s', async (spelling) => {
    await locks.acquire(WS, BRANCH, CANONICAL, ALICE);

    await locks.release(WS, BRANCH, spelling, ALICE);

    expect(fake.rows()).toEqual([]);
    expect(await locks.get(WS, BRANCH, CANONICAL)).toBeNull();
  });

  it.each(SPELLINGS)('reads a canonically-taken lock spelled as %s', async (spelling) => {
    await locks.acquire(WS, BRANCH, CANONICAL, ALICE);

    const read = await locks.get(WS, BRANCH, spelling);

    expect(read?.holderUserId).toBe(ALICE.id);
    expect(read?.path).toBe(CANONICAL);
  });

  it('goes the other way too: taken raw, released and read canonically', async () => {
    await locks.acquire(WS, BRANCH, './knowledge-base//x//a.md', ALICE);

    expect((await locks.get(WS, BRANCH, CANONICAL))?.holderUserId).toBe(ALICE.id);
    await locks.release(WS, BRANCH, CANONICAL, ALICE);
    expect(fake.rows()).toEqual([]);
  });

  /**
   * A path the canonicaliser refuses to touch must not become a lock row of
   * its own. The statuses match what the file verbs answer for the same
   * input: `WorkspaceService.withPathTurn` validates first (400) and checks
   * workspace containment second (403).
   */
  describe('refuses a path the file verbs would refuse', () => {
    const REFUSED: [string, string, new () => Error][] = [
      ['climbs out of the workspace', '../etc/passwd', WorkflowValidationError],
      ['climbs out from inside', 'knowledge-base/../../etc/passwd', WorkflowValidationError],
      ['launders back inside', 'knowledge-base/x/../y.md', WorkflowValidationError],
      ['is a bare parent', '..', WorkflowValidationError],
      ['is the current directory', '.', WorkflowValidationError],
      ['uses backslashes', 'knowledge-base\\x\\a.md', WorkflowValidationError],
      ['is absolute', '/etc/passwd', PathTraversalError],
    ];

    it.each(REFUSED)('acquire refuses a path that %s', async (_why, badPath, error) => {
      await expect(locks.acquire(WS, BRANCH, badPath, ALICE)).rejects.toBeInstanceOf(error);
      expect(fake.rows()).toEqual([]);
    });

    it.each(REFUSED)('heartbeat refuses a path that %s', async (_why, badPath, error) => {
      await expect(locks.heartbeat(WS, BRANCH, badPath, ALICE)).rejects.toBeInstanceOf(error);
    });

    it.each(REFUSED)('release refuses a path that %s', async (_why, badPath, error) => {
      await locks.acquire(WS, BRANCH, CANONICAL, ALICE);
      await expect(locks.release(WS, BRANCH, badPath, ALICE)).rejects.toBeInstanceOf(error);
      // Nothing was deleted on the way to the refusal.
      expect(fake.rows()).toHaveLength(1);
    });

    it.each(REFUSED)('get refuses a path that %s', async (_why, badPath, error) => {
      await expect(locks.get(WS, BRANCH, badPath)).rejects.toBeInstanceOf(error);
    });
  });
});
