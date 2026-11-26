import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthUser } from '@bevel-software/platform-shared';
import { testKbContext } from '../../../__tests__/kb-context.js';
import type { GitService } from '../git/git.service.js';
import type { PullRequestService } from '../git/pull-request.service.js';
import type { IChangeRequestReviewService } from '../change-request-review/change-request-review.interface.js';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import type { IAccessControl } from '../../access/access-control.interface.js';
import type { PendingCommitsService } from '../pending-commits.service.js';
import { FileLockService } from '../file-lock.service.js';
import { VersionControlEventBus } from '../event-bus.js';
import { VersionControlService } from '../version-control.service.js';
import { AccessDeniedError } from '../../access-model/index.js';
import type { IChangeReadGate } from '../../access-model/index.js';
import { makeFakeLockDb } from './fake-file-lock-db.js';

/**
 * A held lock does not outlive the write access it was granted under.
 *
 * `holdsEditLock` is the question every write under an already-held lock asks
 * (the editor's PUT between Edit and Done, the access mutations, the embed
 * save). It asks the acquire's gate AGAIN, so an admin removing the grant
 * while the lock is held takes effect at the holder's next write: refused
 * with the acquire's 403, and the lock released.
 *
 * The lock half is the real `FileLockService` over the in-memory table the
 * version-control suites use; the access answers are flipped mid-test the way
 * an admin rewriting `access.md` flips them.
 */

const KB = 'knowledge-base';
// One of the branches the backend test config marks protected.
const PROTECTED = 'target-company-state';
const DRAFT = 'alice/propose-plan';
const WS = 'ws-1';
const PATH = `${KB}/QA-Edit/notes.md`;
const ALICE: AuthUser = { id: '11111111-1111-4111-8111-111111111111', email: 'alice@example.com', name: 'Alice' };
const BOB: AuthUser = { id: '22222222-2222-4222-8222-222222222222', email: 'bob@example.com', name: 'Bob' };

let writable: boolean;
let readable: boolean;
let locks: FileLockService;
let enqueue: ReturnType<typeof vi.fn>;
let canWriteBatchAtRef: ReturnType<typeof vi.fn>;
let svc: VersionControlService;

beforeEach(() => {
  writable = true;
  readable = true;
  locks = new FileLockService(makeFakeLockDb().db);
  enqueue = vi.fn(async () => undefined);
  canWriteBatchAtRef = vi.fn(async (_w: string, _r: string, _e: string, paths: string[]) =>
    new Map(paths.map((p) => [p, writable])),
  );
  const accessControl = {
    canWriteBatchAtRef,
    eligibleWritersAtRef: vi.fn(async () => ({ roles: [], users: [] })),
    canRestorePlatformFile: vi.fn(async () => false),
  } as unknown as IAccessControl;
  const gate: IChangeReadGate = {
    judge: vi.fn(),
    assertMayChange: vi.fn(async (_w: string, _e: string, wsPath: string) => {
      if (readable) return;
      throw new AccessDeniedError({ path: wsPath, eligibleRoles: [], eligibleUsers: [], unreadable: 'QA-Edit' });
    }),
  };
  svc = new VersionControlService(
    {} as never,
    {} as GitService,
    {} as PullRequestService,
    {} as IChangeRequestReviewService,
    {} as WorkspaceService,
    accessControl,
    locks,
    { enqueue } as unknown as PendingCommitsService,
    testKbContext({ kbDirName: KB }),
    gate,
    new VersionControlEventBus(),
  );
});

describe('holdsEditLock', () => {
  it('answers true for the holder while the grant stands, and leaves the lock held', async () => {
    expect((await svc.acquireLock(WS, PROTECTED, PATH, ALICE)).acquired).toBe(true);

    await expect(svc.holdsEditLock(WS, PROTECTED, PATH, ALICE)).resolves.toBe(true);
    expect((await locks.get(WS, PROTECTED, PATH))?.holderUserId).toBe(ALICE.id);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('refuses the holder with the acquire\'s 403 once write is revoked, and releases the lock', async () => {
    expect((await svc.acquireLock(WS, PROTECTED, PATH, ALICE)).acquired).toBe(true);
    writable = false;
    // A non-holder's refusal at the acquire, for comparison.
    const fromAcquire = await svc.acquireLock(WS, PROTECTED, `${KB}/QA-Edit/other.md`, BOB).then(
      () => null,
      (e: unknown) => e,
    );

    const held = await svc.holdsEditLock(WS, PROTECTED, PATH, ALICE).then(
      () => null,
      (e: unknown) => e,
    );

    expect(held).toBeInstanceOf(AccessDeniedError);
    expect(fromAcquire).toBeInstanceOf(AccessDeniedError);
    expect((held as AccessDeniedError).status).toBe(403);
    expect((held as AccessDeniedError).message).toBe(
      (fromAcquire as AccessDeniedError).message.replace('other.md', 'notes.md'),
    );
    // The lock is gone: nobody waits on a holder who can no longer write.
    expect(await locks.get(WS, PROTECTED, PATH)).toBeNull();
    // Released through the publishing release: what landed while the grant
    // stood is not thrown away by the revoke.
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ path: PATH, authorEmail: ALICE.email }));
    // Asked again, the former holder simply holds nothing.
    await expect(svc.holdsEditLock(WS, PROTECTED, PATH, ALICE)).resolves.toBe(false);
  });

  it('on a draft branch, a revoked READ refuses and releases the same way', async () => {
    expect((await svc.acquireLock(WS, DRAFT, PATH, ALICE)).acquired).toBe(true);
    readable = false;

    await expect(svc.holdsEditLock(WS, DRAFT, PATH, ALICE)).rejects.toBeInstanceOf(AccessDeniedError);
    expect(await locks.get(WS, DRAFT, PATH)).toBeNull();
  });

  it('answers false, without asking the gate, when the caller holds nothing there', async () => {
    await expect(svc.holdsEditLock(WS, PROTECTED, PATH, ALICE)).resolves.toBe(false);
    expect(canWriteBatchAtRef).not.toHaveBeenCalled();
  });

  it('answers false for somebody else\'s lock, and leaves it alone', async () => {
    expect((await svc.acquireLock(WS, PROTECTED, PATH, BOB)).acquired).toBe(true);
    writable = false;

    await expect(svc.holdsEditLock(WS, PROTECTED, PATH, ALICE)).resolves.toBe(false);
    expect((await locks.get(WS, PROTECTED, PATH))?.holderUserId).toBe(BOB.id);
  });

  it('answers false for the caller\'s own coordination hold, which grants no write', async () => {
    expect((await svc.acquireLock(WS, PROTECTED, PATH, ALICE, { coordination: true })).acquired).toBe(true);

    await expect(svc.holdsEditLock(WS, PROTECTED, PATH, ALICE)).resolves.toBe(false);
  });

  it('knows the lock under any spelling of the path', async () => {
    expect((await svc.acquireLock(WS, PROTECTED, PATH, ALICE)).acquired).toBe(true);
    writable = false;

    await expect(svc.holdsEditLock(WS, PROTECTED, `./${KB}//QA-Edit/notes.md`, ALICE)).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
    expect(await locks.get(WS, PROTECTED, PATH)).toBeNull();
  });

  it('a rules read that FAILED is not a refusal: it propagates and the lock stays held', async () => {
    expect((await svc.acquireLock(WS, PROTECTED, PATH, ALICE)).acquired).toBe(true);
    canWriteBatchAtRef.mockRejectedValueOnce(new Error('git ls-tree failed'));

    await expect(svc.holdsEditLock(WS, PROTECTED, PATH, ALICE)).rejects.toThrow('git ls-tree failed');
    expect((await locks.get(WS, PROTECTED, PATH))?.holderUserId).toBe(ALICE.id);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('a release whose lock drop fails still answers the refusal, not the release error', async () => {
    expect((await svc.acquireLock(WS, PROTECTED, PATH, ALICE)).acquired).toBe(true);
    writable = false;
    const drop = vi.spyOn(locks, 'release').mockRejectedValueOnce(new Error('lock table down'));

    const held = await svc.holdsEditLock(WS, PROTECTED, PATH, ALICE).then(
      () => null,
      (e: unknown) => e,
    );

    expect(held).toBeInstanceOf(AccessDeniedError);
    expect((held as AccessDeniedError).status).toBe(403);
    // The release got as far as dropping the row, and that is what failed.
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ path: PATH }));
    expect(drop).toHaveBeenCalled();
  });

  it('a release whose commit enqueue fails still answers the refusal, and leaves the lock to its TTL', async () => {
    expect((await svc.acquireLock(WS, PROTECTED, PATH, ALICE)).acquired).toBe(true);
    writable = false;
    enqueue.mockRejectedValueOnce(new Error('queue down'));

    await expect(svc.holdsEditLock(WS, PROTECTED, PATH, ALICE)).rejects.toBeInstanceOf(AccessDeniedError);
    // `releaseLock` enqueues before it drops, so nothing was dropped.
    expect((await locks.get(WS, PROTECTED, PATH))?.holderUserId).toBe(ALICE.id);
  });
});
