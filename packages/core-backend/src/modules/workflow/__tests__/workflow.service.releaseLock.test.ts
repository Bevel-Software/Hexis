import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';
import type { AuthUser, Change } from '@bevel-software/platform-shared';
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
import {
  PushNeedsAgentResolutionError,
  WorkflowValidationError,
} from '../workflow.errors.js';

/**
 * Two surfaces under test:
 *
 *   1. `WorkflowService.releaseLock` — new shape (enqueue + drop lock,
 *      no synchronous commit).
 *   2. `WorkflowService.runPendingCommit` — what the background worker
 *      calls per claimed row. This is where the old releaseLock's
 *      commit + cooperative-push + recovery body now lives, so the
 *      non-FF + auth-failure + double-push-fail scenarios moved here.
 *
 * The non-fast-forward push recovery path has burned us in production
 * before; every scenario asserts both the git calls AND the SSE
 * events: a successful commit MUST emit `file-changed`; a failed
 * commit MUST NOT (other clients would otherwise refetch a sha they
 * can't reach on origin yet).
 */

const USER: AuthUser = {
  id: 'user-1',
  email: 'alice@example.com',
  name: 'Alice',
};

const CHANGE: Change = {
  sha: 'abc1234',
  authorName: 'Alice',
  authorEmail: 'alice@example.com',
  subject: 'edit foo.md',
  committedAt: '2026-04-20T00:00:00.000Z',
};

function makeFileLocks(holderUserId: string): FileLockService {
  return {
    acquire: vi.fn(),
    heartbeat: vi.fn(),
    release: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue({
      branch: 'feat/x',
      path: 'foo.md',
      holderUserId,
      holderName: 'Alice',
      acquiredAt: '',
      lastHeartbeatAt: '',
      expiresAt: '',
    }),
  } as unknown as FileLockService;
}

function makePending(): PendingCommitsService {
  return {
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
          'git push failed: Command failed: git push -u origin feat/x\n' +
            ' ! [rejected]        feat/x -> feat/x (non-fast-forward)\n' +
            'error: failed to push some refs to https://example.com/repo.git\n' +
            'hint: Updates were rejected because the tip of your current branch is behind\n',
        );
      }
      if (phase === 'auth-fail') {
        throw new Error('git push failed: Command failed: ... fatal: Authentication failed');
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

function makeFacade(
  git: GitService,
  locks: FileLockService,
  pending: PendingCommitsService,
  events: WorkflowEventBus,
): WorkflowService {
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

describe('WorkflowService.releaseLock — new (enqueue, no synchronous commit)', () => {
  let events: WorkflowEventBus;
  let emitSpy: MockInstance;

  beforeEach(() => {
    events = new WorkflowEventBus();
    emitSpy = vi.spyOn(events, 'emit');
  });

  it('enqueues a pending-commit row, drops the lock, emits lock-released (NO commit, NO push)', async () => {
    const git = makeGit();
    const locks = makeFileLocks(USER.id);
    const pending = makePending();
    const svc = makeFacade(git, locks, pending, events);

    await expect(svc.releaseLock('ws-1', 'feat/x', 'foo.md', USER)).resolves.toBeUndefined();

    expect(pending.enqueue).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      branch: 'feat/x',
      path: 'foo.md',
      authorEmail: USER.email,
      authorName: USER.name,
    });
    expect(locks.release).toHaveBeenCalledTimes(1);
    // Critical: the new shape doesn't touch git on the user-visible
    // path. Commit + push happen later in the worker via runPendingCommit.
    expect(git.commitFile).not.toHaveBeenCalled();
    expect(git.push).not.toHaveBeenCalled();
    // Only lock-released fires synchronously now; file-changed lands when
    // the worker's commit succeeds (covered in the runPendingCommit suite).
    expect(emitSpy.mock.calls.map((c) => (c[0] as { kind: string }).kind)).toEqual(['lock-released']);
  });

  it('throws lock-not-held when the caller does not hold the lock', async () => {
    const git = makeGit();
    const locks = makeFileLocks('someone-else');
    const pending = makePending();
    const svc = makeFacade(git, locks, pending, events);

    await expect(svc.releaseLock('ws-1', 'feat/x', 'foo.md', USER)).rejects.toBeInstanceOf(
      WorkflowValidationError,
    );
    // Ownership guard MUST run before we enqueue — otherwise a non-holder
    // could schedule a commit attributed to themselves on any file.
    expect(pending.enqueue).not.toHaveBeenCalled();
    expect(locks.release).not.toHaveBeenCalled();
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it('throws lock-not-held when the lock row is missing entirely (TTL expired + GC)', async () => {
    const git = makeGit();
    const locks = {
      ...makeFileLocks(USER.id),
      get: vi.fn().mockResolvedValue(null),
    } as unknown as FileLockService;
    const pending = makePending();
    const svc = makeFacade(git, locks, pending, events);

    await expect(svc.releaseLock('ws-1', 'feat/x', 'foo.md', USER)).rejects.toBeInstanceOf(
      WorkflowValidationError,
    );
    expect(pending.enqueue).not.toHaveBeenCalled();
  });

  it('surfaces lock-release failure without rolling back the enqueue', async () => {
    // Documents the deliberate ordering at workflow.service.ts:
    // enqueue first, drop second. If `locks.release` throws after a
    // successful `pending.enqueue`, we let the error propagate — the
    // queued row stays so the worker eventually commits the file, and
    // the held lock will be reaped by its TTL. "Brief over-lock" is the
    // documented trade-off; the alternative (drop-then-enqueue) would
    // re-introduce the orphan-files bug the queue exists to prevent.
    const git = makeGit();
    const locks = {
      ...makeFileLocks(USER.id),
      release: vi.fn().mockRejectedValue(new Error('db connection lost')),
    } as unknown as FileLockService;
    const pending = makePending();
    const svc = makeFacade(git, locks, pending, events);

    await expect(svc.releaseLock('ws-1', 'feat/x', 'foo.md', USER)).rejects.toThrow(
      /db connection lost/,
    );

    // Enqueue happened first and was NOT compensated/rolled back.
    expect(pending.enqueue).toHaveBeenCalledTimes(1);
    expect(pending.enqueue).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      branch: 'feat/x',
      path: 'foo.md',
      authorEmail: USER.email,
      authorName: USER.name,
    });
    // Release was attempted (and threw).
    expect(locks.release).toHaveBeenCalledTimes(1);
    // No git side effects on the user path — the worker handles those.
    expect(git.commitFile).not.toHaveBeenCalled();
    expect(git.push).not.toHaveBeenCalled();
    // No `lock-released` event when the release itself failed; the lock
    // is still held, and we'd lie to any SSE subscriber by emitting.
    expect(emitSpy).not.toHaveBeenCalled();
  });
});

describe('WorkflowService.runPendingCommit — worker entry point', () => {
  let events: WorkflowEventBus;
  let emitSpy: MockInstance;

  beforeEach(() => {
    events = new WorkflowEventBus();
    emitSpy = vi.spyOn(events, 'emit');
  });

  it('happy path: commits + pushes, emits file-changed with the new sha', async () => {
    const git = makeGit();
    const svc = makeFacade(git, makeFileLocks(USER.id), makePending(), events);

    await svc.runPendingCommit('ws-1', 'feat/x', 'foo.md', USER);

    expect(git.commitFile).toHaveBeenCalledTimes(1);
    expect(git.push).toHaveBeenCalledTimes(1);
    expect(git.pull).not.toHaveBeenCalled();
    expect(emitSpy.mock.calls.map((c) => (c[0] as { kind: string }).kind)).toEqual(['file-changed']);
    expect(emitSpy.mock.calls[0][0]).toMatchObject({
      kind: 'file-changed',
      newSha: CHANGE.sha,
      byUserId: USER.id,
    });
  });

  it('skips push + file-changed when commitFile reports nothing dirty (double-enqueue, identical bytes)', async () => {
    // The worker treats a no-op commit as success and drops the row.
    // No push, no SSE event — there's no new sha for clients to see.
    const git = makeGit({ commitFile: null });
    const svc = makeFacade(git, makeFileLocks(USER.id), makePending(), events);

    await svc.runPendingCommit('ws-1', 'feat/x', 'foo.md', USER);

    expect(git.commitFile).toHaveBeenCalledTimes(1);
    expect(git.push).not.toHaveBeenCalled();
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it('recovers from non-fast-forward push via pull --rebase + retry, emits file-changed exactly once', async () => {
    // Teammate pushed to the same branch between our commit and our
    // push. The cooperative path pulls + retries — this is the case
    // the worker handles without escalating to the recovery agent.
    const git = makeGit({ pushBehavior: 'nff' });
    const svc = makeFacade(git, makeFileLocks(USER.id), makePending(), events);

    await svc.runPendingCommit('ws-1', 'feat/x', 'foo.md', USER);

    expect(git.pull).toHaveBeenCalledTimes(1);
    expect(git.push).toHaveBeenCalledTimes(2);
    expect(emitSpy.mock.calls.map((c) => (c[0] as { kind: string }).kind)).toEqual(['file-changed']);
  });

  it('throws PushNeedsAgentResolutionError on auth failure so the worker can escalate', async () => {
    // Auth failures aren't divergences pull-rebase can resolve. The
    // worker's catch arm decides what to do (transient retry → recovery
    // agent → needs_attention) based on its own budgets.
    const git = makeGit({ pushBehavior: 'auth-fail' });
    const svc = makeFacade(git, makeFileLocks(USER.id), makePending(), events);

    await expect(svc.runPendingCommit('ws-1', 'feat/x', 'foo.md', USER)).rejects.toBeInstanceOf(
      PushNeedsAgentResolutionError,
    );
    expect(git.pull).not.toHaveBeenCalled();
    expect(git.push).toHaveBeenCalledTimes(1);
    // The commit landed locally but we do NOT emit file-changed — other
    // clients would refetch a SHA that's not yet on origin. Recovery
    // (or the next worker pass) emits it when the push actually lands.
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it('throws PushNeedsAgentResolutionError when pull --rebase itself fails (textbook conflict case)', async () => {
    const git = makeGit({ pushBehavior: 'nff', pullBehavior: 'fail' });
    const svc = makeFacade(git, makeFileLocks(USER.id), makePending(), events);

    const err = await svc
      .runPendingCommit('ws-1', 'feat/x', 'foo.md', USER)
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PushNeedsAgentResolutionError);
    expect((err as PushNeedsAgentResolutionError).branch).toBe('feat/x');
    expect((err as PushNeedsAgentResolutionError).path).toBe('foo.md');
    expect(git.pull).toHaveBeenCalledTimes(1);
    expect(git.push).toHaveBeenCalledTimes(1);
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it('throws PushNeedsAgentResolutionError when post-pull retry also fails (origin moved twice)', async () => {
    const git = makeGit({ pushBehavior: 'nff', pushAfterPullBehavior: 'fail' });
    const svc = makeFacade(git, makeFileLocks(USER.id), makePending(), events);

    await expect(svc.runPendingCommit('ws-1', 'feat/x', 'foo.md', USER)).rejects.toBeInstanceOf(
      PushNeedsAgentResolutionError,
    );
    expect(git.pull).toHaveBeenCalledTimes(1);
    expect(git.push).toHaveBeenCalledTimes(2);
    expect(emitSpy).not.toHaveBeenCalled();
  });
});
