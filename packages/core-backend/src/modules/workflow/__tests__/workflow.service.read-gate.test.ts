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
import { WorkflowHooks } from '../workflow-hooks.js';
import { WorkflowService } from '../workflow.service.js';
import type { Database } from '../../database/connection.js';
import { AccessDeniedError } from '../../access-model/access-errors.js';
import type { ChangeReadVerdict, IChangeReadGate } from '../../access-model/change-gate.js';

/**
 * The read-before-write gate sits in `acquireLock` next to the write gate:
 * every non-coordination acquire asks it, on every branch, and a refusal
 * means no lock. The gate's own verdicts are tested in
 * `change-read-gate.test.ts`; here the question is WHEN it is asked and what
 * its answer does.
 */

const USER: AuthUser = { id: 'user-1', email: 'alice@example.com', name: 'Alice' };
const KB = 'knowledge-base';
// One of the branches the backend test config marks protected.
const PROTECTED = 'target-company-state';
const DRAFT = 'alice/propose-plan';
const WS = 'ws-1';

function gateThat(verdict: ChangeReadVerdict) {
  const judge = vi.fn(async () => verdict);
  const assertMayChange = vi.fn(async (workspaceId: string, email: string, wsPath: string, kind: 'file' | 'dir') => {
    const v = await judge(workspaceId, email, wsPath, kind);
    if (v.allowed) return;
    throw new AccessDeniedError({ path: wsPath, eligibleRoles: [], eligibleUsers: [], unreadable: v.unreadable });
  });
  const gate: IChangeReadGate = { judge, assertMayChange };
  return { gate, assertMayChange };
}

function makeService(opts: {
  gate?: IChangeReadGate;
  writable?: boolean;
  canRestorePlatformFile?: boolean;
}) {
  const acquire = vi.fn(async () => ({ acquired: true, lock: {} as never }));
  const accessControl = {
    canWriteBatchAtRef: vi.fn(async (_w: string, _r: string, _e: string, paths: string[]) =>
      new Map(paths.map((p) => [p, opts.writable ?? true])),
    ),
    eligibleWritersAtRef: vi.fn(async () => ({ roles: [], users: [] })),
    canRestorePlatformFile: vi.fn(async () => opts.canRestorePlatformFile ?? false),
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
    undefined,
    new WorkflowHooks(),
    opts.gate,
  );
  return { svc, acquire, accessControl };
}

describe('acquireLock asks the read-before-write gate', () => {
  const PATH = `${KB}/KnowledgeBase/Sealed/brief.pdf`;

  it('on a DRAFT branch, where no write gate runs: a refusal means no lock', async () => {
    const { gate, assertMayChange } = gateThat({ allowed: false, unreadable: 'KnowledgeBase/Sealed' });
    const { svc, acquire, accessControl } = makeService({ gate });

    await expect(svc.acquireLock(WS, DRAFT, PATH, USER)).rejects.toBeInstanceOf(AccessDeniedError);
    expect(assertMayChange).toHaveBeenCalledWith(WS, USER.email, PATH, 'file');
    expect(acquire).not.toHaveBeenCalled();
    // The write gate is still protected-branch only.
    expect(accessControl.canWriteBatchAtRef).not.toHaveBeenCalled();
  });

  it('on a draft branch an allowed change takes the lock as before', async () => {
    const { gate } = gateThat({ allowed: true, via: 'readable' });
    const { svc, acquire } = makeService({ gate });

    const result = await svc.acquireLock(WS, DRAFT, PATH, USER);
    expect(result.acquired).toBe(true);
    expect(acquire).toHaveBeenCalledOnce();
  });

  it('on a PROTECTED branch, after the write gate: a write grant without read is refused', async () => {
    const { gate, assertMayChange } = gateThat({ allowed: false, unreadable: 'KnowledgeBase/Sealed' });
    const { svc, acquire, accessControl } = makeService({ gate, writable: true });

    await expect(svc.acquireLock(WS, PROTECTED, PATH, USER)).rejects.toBeInstanceOf(AccessDeniedError);
    expect(accessControl.canWriteBatchAtRef).toHaveBeenCalledOnce();
    expect(assertMayChange).toHaveBeenCalledOnce();
    expect(acquire).not.toHaveBeenCalled();
  });

  it('the write gate refuses first, so the read gate is never asked about a path the caller may not write', async () => {
    const { gate, assertMayChange } = gateThat({ allowed: true, via: 'readable' });
    const { svc, acquire } = makeService({ gate, writable: false });

    await expect(svc.acquireLock(WS, PROTECTED, PATH, USER)).rejects.toBeInstanceOf(AccessDeniedError);
    expect(assertMayChange).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
  });

  it('the refusal carries the unreadable place, so the route and the tools can say why', async () => {
    const { gate } = gateThat({ allowed: false, unreadable: 'KnowledgeBase/Sealed' });
    const { svc } = makeService({ gate });

    const err = await svc.acquireLock(WS, DRAFT, PATH, USER).then(() => null, (e: unknown) => e);
    expect((err as AccessDeniedError).access.unreadable).toBe('KnowledgeBase/Sealed');
    expect((err as AccessDeniedError).message).toContain('You don\'t have read access to "KnowledgeBase/Sealed"');
  });

  it('a platform-file restore that the write gate let through is not asked — the rescue is for a denying destination', async () => {
    const { gate, assertMayChange } = gateThat({ allowed: false, unreadable: '' });
    const { svc, acquire } = makeService({ gate, writable: false, canRestorePlatformFile: true });

    const result = await svc.acquireLock(WS, PROTECTED, `${KB}/access.md`, USER, {
      platformRestore: { source: `${KB}/Misplaced/access.md` },
    });
    expect(result.acquired).toBe(true);
    expect(assertMayChange).not.toHaveBeenCalled();
    expect(acquire).toHaveBeenCalledOnce();
  });

  it('a coordination hold skips both gates: it grants no write and reads nothing', async () => {
    const { gate, assertMayChange } = gateThat({ allowed: false, unreadable: '' });
    const { svc, acquire, accessControl } = makeService({ gate });

    const result = await svc.acquireLock(WS, PROTECTED, `${KB}/synced-groups.yaml`, USER, { coordination: true });
    expect(result.acquired).toBe(true);
    expect(assertMayChange).not.toHaveBeenCalled();
    expect(accessControl.canWriteBatchAtRef).not.toHaveBeenCalled();
    expect(acquire).toHaveBeenCalledOnce();
  });

  it('is asked with the canonical spelling of the path — the identity the lock is keyed by', async () => {
    const { gate, assertMayChange } = gateThat({ allowed: true, via: 'readable' });
    const { svc } = makeService({ gate });

    await svc.acquireLock(WS, DRAFT, `./${KB}//KnowledgeBase/Open/a.md`, USER);
    expect(assertMayChange).toHaveBeenCalledWith(WS, USER.email, `${KB}/KnowledgeBase/Open/a.md`, 'file');
  });
});
