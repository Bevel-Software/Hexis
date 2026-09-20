import { describe, it, expect, vi } from 'vitest';
import type { AuthUser } from '@bevel-software/platform-shared';
import type { GitService } from '../git/git.service.js';
import type { PullRequestService } from '../git/pull-request.service.js';
import type { IReviewWorkflowService } from '../review-workflow/review-workflow.interface.js';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import type { IAccessControl } from '../../access/access-control.interface.js';
import type { FileLockService } from '../file-lock.service.js';
import type { PendingCommitsService } from '../pending-commits.service.js';
import { WorkflowEventBus } from '../event-bus.js';
import { WorkflowService } from '../workflow.service.js';
import type { Database } from '../../database/connection.js';
import { AccessDeniedError } from '../../access-model/access-errors.js';

/**
 * The write gate stays the single mechanism; the platform-file restore is an
 * exception expressed INSIDE it.
 *
 * `opts.platformRestore` is a claim the caller makes, not an authorisation it
 * carries. The gate re-asks both halves: that source→destination is a restore
 * at all, which it answers itself, and whether this caller may land this exact
 * path, which the access module answers. Only both yeses let the acquire
 * through. These cases hold that apart from a general admin write bypass,
 * which is the thing this rescue must never become — and apart from a flag a
 * future caller could pass to take the root's own copy OUT.
 */

const USER: AuthUser = { id: 'user-1', email: 'razvan@bevel.software', name: 'Razvan' };
const KB = 'knowledge-base';
// One of the branches the backend test config marks protected — the gate runs
// on protected branches only.
const BRANCH = 'target-company-state';
const WS = 'ws-1';

function makeService(canRestorePlatformFile: IAccessControl['canRestorePlatformFile']) {
  const acquire = vi.fn(async () => ({ acquired: true, lock: {} as never }));
  const accessControl = {
    // Everything is denied at the ref: the broken repository whose root has
    // no `access.md` answers exactly this, to everyone.
    canWriteBatchAtRef: vi.fn(async (_w: string, _r: string, _e: string, paths: string[]) =>
      new Map(paths.map((p) => [p, false])),
    ),
    eligibleWritersAtRef: vi.fn(async () => ({ roles: [], users: [] })),
    canRestorePlatformFile: vi.fn(canRestorePlatformFile),
  } as unknown as IAccessControl;
  const svc = new WorkflowService(
    {} as unknown as Database,
    {} as GitService,
    {} as PullRequestService,
    {} as IReviewWorkflowService,
    {} as WorkspaceService,
    accessControl,
    { acquire, get: vi.fn(async () => null) } as unknown as FileLockService,
    {} as PendingCommitsService,
    KB,
    new WorkflowEventBus(),
  );
  return { svc, acquire, accessControl };
}

describe('acquiring the destination lock of a platform-file restore', () => {
  const MISPLACED = `${KB}/Misplaced/access.md`;

  it('lets the write past a destination that denies it when the access module says this is a restore', async () => {
    const { svc, acquire, accessControl } = makeService(async () => true);

    const result = await svc.acquireLock(WS, BRANCH, `${KB}/access.md`, USER, {
      platformRestore: { source: MISPLACED },
    });

    expect(result.acquired).toBe(true);
    expect(acquire).toHaveBeenCalledOnce();
    // Asked repo-relative — the form the access model is keyed by.
    expect(accessControl.canRestorePlatformFile).toHaveBeenCalledWith(WS, USER.email, 'access.md');
  });

  it('refuses when the access module says this caller may not restore this path', async () => {
    const { svc, acquire } = makeService(async () => false);

    await expect(
      svc.acquireLock(WS, BRANCH, `${KB}/access.md`, USER, { platformRestore: { source: MISPLACED } }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    expect(acquire).not.toHaveBeenCalled();
  });

  it('a claim whose source is the copy the platform reads is refused without asking anyone', async () => {
    // The move the whole feature exists to stop, wearing the rescue's clothes:
    // the ROOT's own access.md carried into a folder that has none. The access
    // module would say yes — it is only ever asked where the write LANDS — so
    // the gate answers this one itself rather than passing it on.
    const { svc, acquire, accessControl } = makeService(async () => true);

    await expect(
      svc.acquireLock(WS, BRANCH, `${KB}/Sales/access.md`, USER, {
        platformRestore: { source: `${KB}/access.md` },
      }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    expect(accessControl.canRestorePlatformFile).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
  });

  it('a claim on any other path buys nothing — it is not a restore and is never asked about', async () => {
    const { svc, acquire, accessControl } = makeService(async () => true);

    await expect(
      svc.acquireLock(WS, BRANCH, `${KB}/Sales/deal.md`, USER, {
        platformRestore: { source: `${KB}/Misplaced/deal.md` },
      }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    expect(accessControl.canRestorePlatformFile).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
  });

  it('a restore must keep the name: a misplaced access.md may not arrive as roles.yaml', async () => {
    const { svc, acquire, accessControl } = makeService(async () => true);

    await expect(
      svc.acquireLock(WS, BRANCH, `${KB}/roles.yaml`, USER, { platformRestore: { source: MISPLACED } }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    expect(accessControl.canRestorePlatformFile).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
  });

  it('without the claim the exception is never even considered', async () => {
    const { svc, acquire, accessControl } = makeService(async () => true);

    await expect(
      svc.acquireLock(WS, BRANCH, `${KB}/access.md`, USER),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    expect(accessControl.canRestorePlatformFile).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
  });
});
