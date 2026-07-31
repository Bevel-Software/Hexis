import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AuthUser, Change } from '@bevel-software/shared';
import type { GitService } from '../git/git.service.js';
import type { PullRequestService } from '../git/pull-request.service.js';
import type { IReviewWorkflowService } from '../review-workflow/review-workflow.interface.js';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import type { IAccessControl } from '../../access/access-control.interface.js';
import { FileLockService } from '../file-lock.service.js';
import { PendingCommitsService } from '../pending-commits.service.js';
import { WorkflowEventBus } from '../event-bus.js';
import { WorkflowService } from '../workflow.service.js';
import type { Database } from '../../database/connection.js';
import { WorkflowValidationError } from '../workflow.errors.js';

/**
 * `commitFileWhileLocked` (autosave checkpoint) has subtler semantics
 * than `releaseLock`: the lock stays held, push failures are best-effort
 * (the user is mid-edit and shouldn't see a failed-save banner for a
 * background autosave), and `file-changed` still fires on a landed
 * commit so other tailing clients refresh promptly. These tests pin
 * those distinctions down so a future refactor can't quietly turn
 * "autosave is best-effort" into "autosave throws and breaks the editor".
 */

const USER: AuthUser = { id: 'user-1', email: 'alice@example.com', name: 'Alice' };

const CHANGE: Change = {
  sha: 'def4567',
  authorName: 'Alice',
  authorEmail: 'alice@example.com',
  subject: 'checkpoint',
  committedAt: '2026-04-20T00:00:00.000Z',
};

function makeFileLocks(holderUserId: string | null): FileLockService {
  return {
    acquire: vi.fn(),
    heartbeat: vi.fn(),
    release: vi.fn(),
    get: vi.fn().mockResolvedValue(
      holderUserId === null
        ? null
        : {
            branch: 'feat/x',
            path: 'foo.md',
            holderUserId,
            holderName: 'Alice',
            acquiredAt: '',
            lastHeartbeatAt: '',
            expiresAt: '',
          },
    ),
  } as unknown as FileLockService;
}

function makeGit(overrides: Partial<{
  commitFile: Change | null;
  pushBehavior: 'ok' | 'nff' | 'auth-fail';
  pullBehavior: 'ok' | 'fail';
  pushAfterPullBehavior: 'ok' | 'fail';
}> = {}): GitService {
  const commitFileResult = overrides.commitFile === undefined ? CHANGE : overrides.commitFile;
  const pushBehavior = overrides.pushBehavior ?? 'ok';
  const pullBehavior = overrides.pullBehavior ?? 'ok';
  const pushAfterPullBehavior = overrides.pushAfterPullBehavior ?? 'ok';
  let pushCalls = 0;
  return {
    commitFile: vi.fn().mockResolvedValue(commitFileResult),
    push: vi.fn().mockImplementation(async () => {
      pushCalls++;
      const phase = pushCalls === 1 ? pushBehavior : pushAfterPullBehavior;
      if (phase === 'nff') {
        throw new Error(
          'git push failed: Command failed: ...\n ! [rejected]        feat/x (non-fast-forward)',
        );
      }
      if (phase === 'auth-fail') {
        throw new Error('fatal: Authentication failed');
      }
      if (phase === 'fail') {
        throw new Error('git push failed (post-pull retry)');
      }
    }),
    pull: vi.fn().mockImplementation(async () => {
      if (pullBehavior === 'fail') throw new Error('git pull failed: merge conflict');
    }),
  } as unknown as GitService;
}

function makeFacade(git: GitService, locks: FileLockService, events: WorkflowEventBus): WorkflowService {
  // Pending-commits is irrelevant to commitFileWhileLocked (autosave
  // checkpoint commits land synchronously, not through the queue), so a
  // bare stub suffices.
  const pending = {
    enqueue: vi.fn().mockResolvedValue(undefined),
    claimNext: vi.fn().mockResolvedValue(null),
    markSucceeded: vi.fn().mockResolvedValue(undefined),
    markTransientFailure: vi.fn().mockResolvedValue(undefined),
    markRecoveryStarted: vi.fn().mockResolvedValue(undefined),
    markNeedsAttention: vi.fn().mockResolvedValue(undefined),
    listNeedsAttention: vi.fn().mockResolvedValue([]),
    countPending: vi.fn().mockResolvedValue(0),
    startupReconcile: vi.fn().mockResolvedValue(undefined),
  } as unknown as PendingCommitsService;
  return new WorkflowService(
    {} as unknown as Database,
    git,
    {} as PullRequestService,
    {} as IReviewWorkflowService,
    {} as WorkspaceService,
    {} as IAccessControl,
    locks,
    pending,
    'knowledge-base',
    events,
  );
}

describe('WorkflowService.commitFileWhileLocked', () => {
  let events: WorkflowEventBus;
  let emitSpy: ReturnType<typeof spyOnEmit>;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  function spyOnEmit() { return vi.spyOn(new WorkflowEventBus(), 'emit'); }

  beforeEach(() => {
    events = new WorkflowEventBus();
    emitSpy = vi.spyOn(events, 'emit');
  });

  it('happy path: commits, pushes, leaves lock held, emits file-changed (NOT lock-released)', async () => {
    // Autosave-style checkpoint: midway through editing, persist + commit
    // so a crash doesn't lose progress. The lock STAYS held so the user
    // can keep typing without re-acquiring on every keystroke.
    const git = makeGit();
    const locks = makeFileLocks(USER.id);
    const svc = makeFacade(git, locks, events);

    const change = await svc.commitFileWhileLocked('ws-1', 'feat/x', 'foo.md', USER);

    expect(change).toEqual(CHANGE);
    expect(git.commitFile).toHaveBeenCalledTimes(1);
    expect(git.push).toHaveBeenCalledTimes(1);
    // Crucial: NO lock-released emit (the lock is still held).
    expect(emitSpy.mock.calls.map((c) => (c[0] as { kind: string }).kind)).toEqual([
      'file-changed',
    ]);
    expect(emitSpy.mock.calls[0][0]).toMatchObject({
      kind: 'file-changed',
      newSha: CHANGE.sha,
    });
    expect(locks.release).not.toHaveBeenCalled();
  });

  it('returns null without pushing or emitting when commitFile finds no diff', async () => {
    const git = makeGit({ commitFile: null });
    const locks = makeFileLocks(USER.id);
    const svc = makeFacade(git, locks, events);

    const change = await svc.commitFileWhileLocked('ws-1', 'feat/x', 'foo.md', USER);

    expect(change).toBeNull();
    expect(git.push).not.toHaveBeenCalled();
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it('throws lock-not-held when the caller does not hold the lock', async () => {
    const git = makeGit();
    const locks = makeFileLocks('someone-else');
    const svc = makeFacade(git, locks, events);

    await expect(svc.commitFileWhileLocked('ws-1', 'feat/x', 'foo.md', USER)).rejects.toBeInstanceOf(
      WorkflowValidationError,
    );
    expect(git.commitFile).not.toHaveBeenCalled();
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it('still emits file-changed when push fails with a non-recoverable error (commit landed locally)', async () => {
    // Autosave is best-effort on push. If we can't ship the bytes upstream
    // (e.g. transient auth failure), we still emit `file-changed` so the
    // same user's other open tabs / agent see the local commit. The push
    // catches up on the next checkpoint or final release.
    const git = makeGit({ pushBehavior: 'auth-fail' });
    const locks = makeFileLocks(USER.id);
    const svc = makeFacade(git, locks, events);

    // Should NOT throw — autosave is best-effort.
    const change = await svc.commitFileWhileLocked('ws-1', 'feat/x', 'foo.md', USER);
    expect(change).toEqual(CHANGE);
    expect(git.pull).not.toHaveBeenCalled();
    expect(emitSpy.mock.calls.map((c) => (c[0] as { kind: string }).kind)).toEqual([
      'file-changed',
    ]);
  });

  it('attempts pull --rebase + retry push on non-fast-forward, then emits file-changed', async () => {
    // Same recovery as releaseLock — a teammate pushed first, we pull
    // their commits, then retry. The autosave is best-effort so even
    // if recovery fails we don't throw (covered by next test).
    const git = makeGit({ pushBehavior: 'nff' });
    const locks = makeFileLocks(USER.id);
    const svc = makeFacade(git, locks, events);

    const change = await svc.commitFileWhileLocked('ws-1', 'feat/x', 'foo.md', USER);

    expect(change).toEqual(CHANGE);
    expect(git.pull).toHaveBeenCalledTimes(1);
    expect(git.push).toHaveBeenCalledTimes(2);
    expect(emitSpy.mock.calls.map((c) => (c[0] as { kind: string }).kind)).toEqual([
      'file-changed',
    ]);
  });

  it('best-effort: still emits file-changed when non-fast-forward recovery itself fails', async () => {
    // Pull rebase failed (conflicts) or retry-push got rejected again.
    // Autosave must NOT throw — the user is mid-edit and would see a
    // baffling error banner for something they didn't even trigger.
    // The local commit landed; the next checkpoint or final release
    // will retry the push.
    const git = makeGit({ pushBehavior: 'nff', pullBehavior: 'fail' });
    const locks = makeFileLocks(USER.id);
    const svc = makeFacade(git, locks, events);

    const change = await svc.commitFileWhileLocked('ws-1', 'feat/x', 'foo.md', USER);
    expect(change).toEqual(CHANGE);
    // Even though push never succeeded, file-changed still emits so the
    // local commit is visible to other tabs of the same user.
    expect(emitSpy.mock.calls.map((c) => (c[0] as { kind: string }).kind)).toEqual([
      'file-changed',
    ]);
  });
});
