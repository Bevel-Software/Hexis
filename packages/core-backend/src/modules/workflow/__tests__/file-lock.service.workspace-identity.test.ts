import { describe, it, expect, beforeEach } from 'vitest';
import type { AuthUser } from '@bevel-software/platform-shared';
import { FileLockService } from '../file-lock.service.js';
import { workspaceIdForBranch } from '../../../shared/workspace-id.js';
import { makeFakeLockDb, type FakeLockDb } from './fake-file-lock-db.js';

/**
 * A slashed branch's workspace has two spellings: the lock routes pass the
 * `:id` path param Express decoded (`ali/draft`), while the deletion gate and
 * the git status probe ask with the encoded id (`ali%2Fdraft`). Before this,
 * a file held through the app was stored under the first and looked for
 * under the second, so a branch could be deleted with a file on it held.
 */

const ALICE: AuthUser = { id: '11111111-1111-4111-8111-111111111111', email: 'alice@example.com', name: 'Alice' };
const BOB: AuthUser = { id: '22222222-2222-4222-8222-222222222222', email: 'bob@example.com', name: 'Bob' };

const BRANCH = 'ali/draft';
const DECODED = BRANCH;
const ENCODED = workspaceIdForBranch(BRANCH);
const PATH = 'knowledge-base/a.md';

describe('FileLockService coordinates on one workspace id', () => {
  let fake: FakeLockDb;
  let locks: FileLockService;

  beforeEach(() => {
    fake = makeFakeLockDb();
    locks = new FileLockService(fake.db);
  });

  it('stores a lock taken under the decoded id under the encoded one', async () => {
    await locks.acquire(DECODED, BRANCH, PATH, ALICE);
    expect(fake.rows().map((r) => r.workspaceId)).toEqual([ENCODED]);
  });

  it.each([
    ['decoded', DECODED, ENCODED],
    ['encoded', ENCODED, DECODED],
  ])('sees a lock taken under the %s id when asked with the other', async (_how, takenAs, askedAs) => {
    await locks.acquire(takenAs, BRANCH, PATH, ALICE);
    await expect(locks.hasAnyActive(askedAs)).resolves.toBe(true);
    await expect(locks.get(askedAs, BRANCH, PATH)).resolves.toMatchObject({ holderUserId: ALICE.id });
    await expect(locks.acquire(askedAs, BRANCH, PATH, BOB)).resolves.toMatchObject({ acquired: false });
    await expect(locks.heartbeat(askedAs, BRANCH, PATH, ALICE)).resolves.toMatchObject({ path: PATH });
    await locks.release(askedAs, BRANCH, PATH, ALICE);
    expect(fake.rows()).toEqual([]);
    await expect(locks.hasAnyActive(takenAs)).resolves.toBe(false);
  });

  it('leaves an unslashed workspace id as it is', async () => {
    await locks.acquire('main', 'main', PATH, ALICE);
    expect(fake.rows().map((r) => r.workspaceId)).toEqual(['main']);
    await expect(locks.hasAnyActive('main')).resolves.toBe(true);
  });
});

describe('FileLockService honours a lock held across the upgrade, under the decoded id', () => {
  let fake: FakeLockDb;
  let locks: FileLockService;

  /** A row as the service wrote it before workspace ids were canonicalised. */
  const legacyRow = (expiresInMs: number) => {
    const now = Date.now();
    return {
      workspaceId: DECODED,
      branch: BRANCH,
      path: PATH,
      holderUserId: ALICE.id,
      holderName: ALICE.name,
      mode: 'edit',
      acquiredAt: new Date(now - 1_000),
      lastHeartbeatAt: new Date(now - 1_000),
      expiresAt: new Date(now + expiresInMs),
    };
  };

  beforeEach(() => {
    fake = makeFakeLockDb();
    locks = new FileLockService(fake.db);
  });

  it.each([
    ['encoded', ENCODED],
    ['decoded', DECODED],
  ])('a live one is seen asked with the %s id, refuses another editor, and can be heartbeat and released', async (_how, askedAs) => {
    fake.seed(legacyRow(30_000));
    await expect(locks.hasAnyActive(askedAs)).resolves.toBe(true);
    await expect(locks.get(askedAs, BRANCH, PATH)).resolves.toMatchObject({ holderUserId: ALICE.id });
    await expect(locks.acquire(askedAs, BRANCH, PATH, BOB)).resolves.toMatchObject({
      acquired: false,
      lock: { holderUserId: ALICE.id },
    });
    // No second row was written beside it.
    expect(fake.rows().map((r) => r.workspaceId)).toEqual([DECODED]);
    const beat = await locks.heartbeat(askedAs, BRANCH, PATH, ALICE);
    expect(new Date(beat.expiresAt).getTime()).toBeGreaterThan(Date.now() + 30_000);
    await locks.release(askedAs, BRANCH, PATH, ALICE);
    expect(fake.rows()).toEqual([]);
    await expect(locks.hasAnyActive(askedAs)).resolves.toBe(false);
  });

  it('an expired one holds nothing: it is swept, and the file is free under the canonical id', async () => {
    fake.seed(legacyRow(-1_000));
    await expect(locks.hasAnyActive(ENCODED)).resolves.toBe(false);
    await expect(locks.get(ENCODED, BRANCH, PATH)).resolves.toBeNull();
    expect(fake.rows()).toEqual([]);
    await expect(locks.acquire(ENCODED, BRANCH, PATH, BOB)).resolves.toMatchObject({ acquired: true });
    expect(fake.rows().map((r) => r.workspaceId)).toEqual([ENCODED]);
  });
});
