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
 * carries: the gate re-asks the access module about the exact path being
 * written, and only a yes lets the acquire through. These cases hold that
 * apart from a general admin write bypass, which is the thing this rescue
 * must never become.
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
  it('lets the write past a destination that denies it when the access module says this is a restore', async () => {
    const { svc, acquire, accessControl } = makeService(async () => true);

    const result = await svc.acquireLock(WS, BRANCH, `${KB}/access.md`, USER, { platformRestore: true });

    expect(result.acquired).toBe(true);
    expect(acquire).toHaveBeenCalledOnce();
    // Asked repo-relative — the form the access model is keyed by.
    expect(accessControl.canRestorePlatformFile).toHaveBeenCalledWith(WS, USER.email, 'access.md');
  });

  it('refuses when the access module says this caller may not restore this path', async () => {
    const { svc, acquire } = makeService(async () => false);

    await expect(
      svc.acquireLock(WS, BRANCH, `${KB}/access.md`, USER, { platformRestore: true }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    expect(acquire).not.toHaveBeenCalled();
  });

  it('a claim on any other path buys nothing — the access module answers no and the gate refuses', async () => {
    const { svc, acquire, accessControl } = makeService(
      async (_w, _e, dest) => dest === 'access.md',
    );

    await expect(
      svc.acquireLock(WS, BRANCH, `${KB}/Sales/deal.md`, USER, { platformRestore: true }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    expect(accessControl.canRestorePlatformFile).toHaveBeenCalledWith(WS, USER.email, 'Sales/deal.md');
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
