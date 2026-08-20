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
  PullRebaseConflictError,
  PushNeedsAgentResolutionError,
  WorkflowValidationError,
} from '../../../shared/domain-errors.js';

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

function makeFileLocks(
  holderUserId: string,
  mode: 'edit' | 'coordination' = 'edit',
): FileLockService {
  return {
    acquire: vi.fn(),
    heartbeat: vi.fn(),
    release: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue({
      branch: 'feat/x',
      path: 'foo.md',
      holderUserId,
      holderName: 'Alice',
      mode,
      acquiredAt: '',
      lastHeartbeatAt: '',
      expiresAt: '',
    }),
  } as unknown as FileLockService;
}

function makePending(): PendingCommitsService {
  return {
    enqueue: vi.fn().mockResolvedValue(undefined),
    enqueueIfAbsent: vi.fn().mockResolvedValue(true),
    claimNext: vi.fn().mockResolvedValue(null),
    markSucceeded: vi.fn().mockResolvedValue(undefined),
    markTransientFailure: vi.fn().mockResolvedValue(undefined),
    markRecoveryStarted: vi.fn().mockResolvedValue(undefined),
    markNeedsAttention: vi.fn().mockResolvedValue(undefined),
    listNeedsAttention: vi.fn().mockResolvedValue([]),
    countPending: vi.fn().mockResolvedValue(0),
    hasLiveRowFor: vi.fn().mockResolvedValue(false),
    startupReconcile: vi.fn().mockResolvedValue(undefined),
  } as unknown as PendingCommitsService;
}

function makeGit(overrides: Partial<{
  commitFile: Change | null;
  pushBehavior: 'ok' | 'nff' | 'auth-fail';
  pullBehavior: 'ok' | 'fail';
  pushAfterPullBehavior: 'ok' | 'fail';
  hasUnpushedCommits: boolean;
}> = {}): GitService {
  const commitFileResult = overrides.commitFile === undefined ? CHANGE : overrides.commitFile;
  const pushBehavior = overrides.pushBehavior ?? 'ok';
  const pullBehavior = overrides.pullBehavior ?? 'ok';
  const pushAfterPullBehavior = overrides.pushAfterPullBehavior ?? 'ok';
  let pushCalls = 0;
  return {
    commitFile: vi.fn().mockResolvedValue(commitFileResult),
    discardPath: vi.fn().mockResolvedValue(undefined),
    hasUnpushedCommits: vi.fn().mockResolvedValue(overrides.hasUnpushedCommits ?? false),
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

  it('REFUSES to release a coordination hold — never enqueues, never drops the row', async () => {
    // A coordination hold was acquired PAST the write-authorization gate on
    // the promise that nothing gets written under it. If releaseLock treated
    // it like an edit lock, the enqueued release commit would publish
    // whatever bytes sit on disk — on machine-owned paths included — under
    // this caller's name. The sanctioned release is releaseLockNoCommit.
    const git = makeGit();
    const locks = makeFileLocks(USER.id, 'coordination');
    const pending = makePending();
    const svc = makeFacade(git, locks, pending, events);

    const err = await svc
      .releaseLock('ws-1', 'feat/x', 'foo.md', USER)
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkflowValidationError);
    expect((err as WorkflowValidationError).payload?.kind).toBe('coordination-hold');
    expect(pending.enqueue).not.toHaveBeenCalled();
    expect(locks.release).not.toHaveBeenCalled();
    expect(emitSpy).not.toHaveBeenCalled();
  });
});

describe('WorkflowService.releaseLockUntouched — drop the row, leave disk AND queue alone', () => {
  let events: WorkflowEventBus;
  let emitSpy: MockInstance;

  beforeEach(() => {
    events = new WorkflowEventBus();
    emitSpy = vi.spyOn(events, 'emit');
  });

  it('releases the lock without enqueueing or discarding, emits lock-released only', async () => {
    const git = makeGit();
    const locks = makeFileLocks(USER.id);
    const pending = makePending();
    const svc = makeFacade(git, locks, pending, events);

    await svc.releaseLockUntouched('ws-1', 'feat/x', 'foo.md', USER);

    expect(locks.release).toHaveBeenCalledTimes(1);
    // The whole point: a prior save's dirty bytes on this path must survive
    // (no discard) without being re-attributed to this caller (no enqueue).
    expect(pending.enqueue).not.toHaveBeenCalled();
    expect(git.discardPath).not.toHaveBeenCalled();
    expect(git.commitFile).not.toHaveBeenCalled();
    expect(git.push).not.toHaveBeenCalled();
    expect(emitSpy.mock.calls.map((c) => (c[0] as { kind: string }).kind)).toEqual(['lock-released']);
  });

  it('no-ops (idempotent) when the caller does not hold the lock', async () => {
    const git = makeGit();
    const locks = makeFileLocks('someone-else');
    const pending = makePending();
    const svc = makeFacade(git, locks, pending, events);

    await expect(
      svc.releaseLockUntouched('ws-1', 'feat/x', 'foo.md', USER),
    ).resolves.toBeUndefined();
    expect(locks.release).not.toHaveBeenCalled();
    expect(emitSpy).not.toHaveBeenCalled();
  });
});

describe('WorkflowService.releaseLockNoCommit — coordination-hold discard guard', () => {
  let events: WorkflowEventBus;

  beforeEach(() => {
    events = new WorkflowEventBus();
  });

  it('discards as usual on an EDIT hold, without consulting the queue', async () => {
    const git = makeGit();
    const pending = makePending();
    const svc = makeFacade(git, makeFileLocks(USER.id), pending, events);

    await svc.releaseLockNoCommit('ws-1', 'feat/x', 'foo.md', USER);

    expect(git.discardPath).toHaveBeenCalledWith('ws-1', 'foo.md');
    expect(pending.hasLiveRowFor).not.toHaveBeenCalled();
  });

  it('discards a coordination hold when the queue has NO live row (wipes smuggled bytes)', async () => {
    const git = makeGit();
    const pending = makePending();
    const emitSpy = vi.spyOn(events, 'emit');
    const svc = makeFacade(git, makeFileLocks(USER.id, 'coordination'), pending, events);

    await svc.releaseLockNoCommit('ws-1', 'feat/x', 'foo.md', USER);

    expect(pending.hasLiveRowFor).toHaveBeenCalledWith('ws-1', 'feat/x', 'foo.md');
    expect(git.discardPath).toHaveBeenCalledWith('ws-1', 'foo.md');
    // The disk really changed here, so watchers are told.
    expect(emitSpy.mock.calls.map((c) => (c[0] as { kind: string }).kind)).toEqual([
      'lock-released',
      'file-changed',
    ]);
  });

  it('SKIPS the discard on a coordination hold when a live queued row exists (a prior save owns the bytes)', async () => {
    // The coordination holder never legitimately wrote the path, so dirty
    // bytes covered by a live pending-commit row belong to an EARLIER save
    // whose commit hasn't drained yet — discarding to HEAD would silently
    // destroy that landed edit.
    const git = makeGit();
    const pending = makePending();
    (pending.hasLiveRowFor as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    const emitSpy = vi.spyOn(events, 'emit');
    const svc = makeFacade(git, makeFileLocks(USER.id, 'coordination'), pending, events);

    await svc.releaseLockNoCommit('ws-1', 'feat/x', 'foo.md', USER);

    expect(git.discardPath).not.toHaveBeenCalled();
    // The lock still releases — only the discard is skipped. And since the
    // disk did NOT change, no file-changed goes out: announcing one would
    // false-refresh every watcher of a file that is exactly as it was.
    expect(emitSpy.mock.calls.map((c) => (c[0] as { kind: string }).kind)).toEqual([
      'lock-released',
    ]);
  });
});

describe('WorkflowService.hasQueuedCommit', () => {
  it('delegates to the pending-commits queue per (workspace, branch, path)', async () => {
    const pending = makePending();
    (pending.hasLiveRowFor as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    const svc = makeFacade(makeGit(), makeFileLocks(USER.id), pending, new WorkflowEventBus());

    await expect(svc.hasQueuedCommit('ws-1', 'feat/x', 'foo.md')).resolves.toBe(true);
    expect(pending.hasLiveRowFor).toHaveBeenCalledWith('ws-1', 'feat/x', 'foo.md');
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

  it('skips push + file-changed on a no-op commit with nothing unpushed (double-enqueue, identical bytes)', async () => {
    // The worker treats a no-op commit as success and drops the row.
    // No push, no SSE event — there's no new sha for clients to see.
    const git = makeGit({ commitFile: null, hasUnpushedCommits: false });
    const svc = makeFacade(git, makeFileLocks(USER.id), makePending(), events);

    await svc.runPendingCommit('ws-1', 'feat/x', 'foo.md', USER);

    expect(git.commitFile).toHaveBeenCalledTimes(1);
    expect(git.push).not.toHaveBeenCalled();
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it('STILL pushes on a no-op commit when the branch is ahead of origin (stranded autosave commit)', async () => {
    // Regression: the autosave path commits locally with a best-effort
    // push. When that push fails, the eventual queue row finds a CLEAN
    // tree — and the old early-return treated it as success, dropping the
    // row without ever pushing. The local commit stayed stranded forever
    // and the recovery ladder never started.
    const git = makeGit({ commitFile: null, hasUnpushedCommits: true });
    const svc = makeFacade(git, makeFileLocks(USER.id), makePending(), events);

    await svc.runPendingCommit('ws-1', 'feat/x', 'foo.md', USER);

    expect(git.push).toHaveBeenCalledTimes(1);
    // No new commit → still no file-changed (there's no new sha).
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it('no-op commit + unpushed + conflicting divergence throws so the worker ladder takes over', async () => {
    // The stranded-commit case where origin ALSO moved with a conflicting
    // change (the production stuck-workspace state): push rejects non-FF,
    // the cooperative pull conflicts — the typed error must reach the
    // worker so its retry → recovery-agent ladder runs.
    const git = makeGit({
      commitFile: null,
      hasUnpushedCommits: true,
      pushBehavior: 'nff',
      pullBehavior: 'fail',
    });
    const svc = makeFacade(git, makeFileLocks(USER.id), makePending(), events);

    await expect(svc.runPendingCommit('ws-1', 'feat/x', 'foo.md', USER)).rejects.toBeInstanceOf(
      PushNeedsAgentResolutionError,
    );
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

describe('WorkflowService.updateFromRemote — pull-conflict recovery dispatch', () => {
  const CONFLICT = new PullRebaseConflictError(
    'main',
    ['PR-Overviews/PR-7.html', 'other.md'],
    'git rebase failed: could not apply 0d7b463',
  );

  function makeConflictingGit(err: unknown): GitService {
    return {
      pull: vi.fn().mockRejectedValue(err),
    } as unknown as GitService;
  }

  it('queues ONE recovery row (first conflicted path, triggering user) and rethrows', async () => {
    const pending = makePending();
    const svc = makeFacade(
      makeConflictingGit(CONFLICT), makeFileLocks(USER.id), pending, new WorkflowEventBus(),
    );

    await expect(svc.updateFromRemote('main', USER)).rejects.toBe(CONFLICT);

    expect(pending.enqueueIfAbsent).toHaveBeenCalledTimes(1);
    expect(pending.enqueueIfAbsent).toHaveBeenCalledWith({
      workspaceId: 'main',
      branch: 'main',
      path: 'PR-Overviews/PR-7.html',
      authorEmail: USER.email,
      authorName: USER.name,
    });
    // `enqueue` (counter-resetting refresh) must NOT be used here — repeated
    // sync attempts would starve the worker's ladder.
    expect(pending.enqueue).not.toHaveBeenCalled();
  });

  it('falls back to the recovery-bot identity when no user is available', async () => {
    const pending = makePending();
    const svc = makeFacade(
      makeConflictingGit(CONFLICT), makeFileLocks(USER.id), pending, new WorkflowEventBus(),
    );

    await expect(svc.updateFromRemote('main')).rejects.toBe(CONFLICT);

    const input = (pending.enqueueIfAbsent as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(input.authorEmail).toContain('recovery-bot@');
  });

  it('does NOT queue recovery for a non-conflict pull failure (transient fetch error)', async () => {
    const pending = makePending();
    const transient = new Error('git fetch failed: could not resolve host');
    const svc = makeFacade(
      makeConflictingGit(transient), makeFileLocks(USER.id), pending, new WorkflowEventBus(),
    );

    await expect(svc.updateFromRemote('main', USER)).rejects.toBe(transient);
    expect(pending.enqueueIfAbsent).not.toHaveBeenCalled();
  });

  it('a queue hiccup does not mask the conflict error', async () => {
    const pending = makePending();
    (pending.enqueueIfAbsent as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('db down'),
    );
    const svc = makeFacade(
      makeConflictingGit(CONFLICT), makeFileLocks(USER.id), pending, new WorkflowEventBus(),
    );

    await expect(svc.updateFromRemote('main', USER)).rejects.toBe(CONFLICT);
  });
});
