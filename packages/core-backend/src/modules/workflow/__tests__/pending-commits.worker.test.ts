import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AuthUser } from '@bevel-software/platform-shared';
import type { ISystemNoticeSink } from '../pending-commits.worker.js';
import {
  N_RECOVERY,
  N_TRANSIENT,
  PendingCommitsWorker,
  type RecoveryAgentRunner,
  type WorkflowCommitDriver,
  type WorkspaceProvider,
} from '../pending-commits.worker.js';
import type {
  PendingCommit,
  PendingCommitsService,
} from '../pending-commits.service.js';

/**
 * Unit tests for the queue-draining worker. The service + workflow layers
 * have their own tests; here we focus on the *decision tree* the worker
 * applies per claimed row:
 *
 *   - Success → markSucceeded, nothing else.
 *   - Failure inside transient budget → markTransientFailure, no recovery agent.
 *   - Failure outside transient budget but inside recovery budget → spawn agent.
 *   - Failure outside recovery budget → mark needs_attention + send feedback notice.
 *
 * We never actually start the polling loop (`start()`) — `drainOnce()` is
 * the seam the tests step through. That avoids fake-timer choreography
 * and keeps the test fast.
 */

const RECOVERY_BOT = { id: 'recovery-bot-id', email: 'recovery-bot@bevel.local', name: 'Recovery Bot' };

function makeRow(overrides: Partial<PendingCommit> = {}): PendingCommit {
  return {
    id: overrides.id ?? 'row-1',
    workspaceId: overrides.workspaceId ?? 'ws-1',
    branch: overrides.branch ?? 'feat/x',
    path: overrides.path ?? 'Foo.md',
    authorEmail: overrides.authorEmail ?? 'alice@example.com',
    authorName: overrides.authorName ?? 'Alice',
    queuedAt: overrides.queuedAt ?? new Date('2026-01-01T00:00:00Z'),
    status: overrides.status ?? 'running',
    attempts: overrides.attempts ?? 0,
    recoveryAgentRuns: overrides.recoveryAgentRuns ?? 0,
    lastAttemptedAt: overrides.lastAttemptedAt ?? null,
    lastError: overrides.lastError ?? null,
  };
}

function makeService(): PendingCommitsService {
  return {
    enqueue: vi.fn().mockResolvedValue(undefined),
    claimNext: vi.fn().mockResolvedValue(null),
    hasReadyRow: vi.fn().mockResolvedValue(false),
    markSucceeded: vi.fn().mockResolvedValue(undefined),
    markTransientFailure: vi.fn().mockResolvedValue(undefined),
    markRecoveryStarted: vi.fn().mockResolvedValue(undefined),
    markNeedsAttention: vi.fn().mockResolvedValue(undefined),
    listNeedsAttention: vi.fn().mockResolvedValue([]),
    countPending: vi.fn().mockResolvedValue(0),
    startupReconcile: vi.fn().mockResolvedValue(undefined),
  } as unknown as PendingCommitsService;
}

function makeWorkspaces(): WorkspaceProvider {
  return {
    knownWorkspaces: () => [{ id: 'ws-1', branch: 'feat/x' }],
  };
}

function makeFeedback(): ISystemNoticeSink {
  return { send: vi.fn().mockResolvedValue(undefined) } as unknown as ISystemNoticeSink;
}

describe('PendingCommitsWorker.drainOnce', () => {
  let service: PendingCommitsService;
  let workflow: WorkflowCommitDriver & {
    runPendingCommit: ReturnType<typeof vi.fn>;
  };
  let recoveryAgent: RecoveryAgentRunner & { run: ReturnType<typeof vi.fn> };
  let feedback: ISystemNoticeSink & { send: ReturnType<typeof vi.fn> };
  let worker: PendingCommitsWorker;

  beforeEach(() => {
    service = makeService();
    workflow = { runPendingCommit: vi.fn() } as never;
    recoveryAgent = { run: vi.fn() } as never;
    feedback = makeFeedback() as never;
    worker = new PendingCommitsWorker({
      service,
      workflow,
      recoveryAgent,
      feedback,
      workspaces: makeWorkspaces(),
      recoveryBot: RECOVERY_BOT,
      now: () => new Date('2026-01-01T00:01:00Z'),
    });
    // drainOnce checks `this.running` against the per-workspace iterator;
    // start() sets it true. We don't want the polling loop, just the
    // single-pass drain, so flip the flag manually.
    (worker as unknown as { running: boolean }).running = true;
  });

  it('happy path: claims row, runs commit, marks succeeded — no other branches taken', async () => {
    const row = makeRow();
    (service.claimNext as ReturnType<typeof vi.fn>).mockResolvedValueOnce(row);
    workflow.runPendingCommit.mockResolvedValueOnce(undefined);

    await worker.drainOnce();

    expect(service.claimNext).toHaveBeenCalledWith('ws-1', expect.any(Date));
    expect(workflow.runPendingCommit).toHaveBeenCalledWith(
      'ws-1',
      'feat/x',
      'Foo.md',
      expect.objectContaining<Partial<AuthUser>>({ email: 'alice@example.com', name: 'Alice' }),
      // Last (only) row of the burst, so the advisory validator runs.
      { skipValidation: false },
    );
    expect(service.markSucceeded).toHaveBeenCalledWith('row-1');
    expect(service.markTransientFailure).not.toHaveBeenCalled();
    expect(service.markRecoveryStarted).not.toHaveBeenCalled();
    expect(service.markNeedsAttention).not.toHaveBeenCalled();
    expect(recoveryAgent.run).not.toHaveBeenCalled();
    expect(feedback.send).not.toHaveBeenCalled();
  });

  it('skips work entirely when claimNext returns null (idle queue)', async () => {
    (service.claimNext as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    await worker.drainOnce();

    expect(workflow.runPendingCommit).not.toHaveBeenCalled();
    expect(service.markSucceeded).not.toHaveBeenCalled();
  });

  it('transient failure (within budget) records the error and does NOT spawn recovery', async () => {
    // attempts=0 → next attempt would be 1, which is < N_TRANSIENT (3).
    const row = makeRow({ attempts: 0 });
    (service.claimNext as ReturnType<typeof vi.fn>).mockResolvedValueOnce(row);
    workflow.runPendingCommit.mockRejectedValueOnce(new Error('transient git error'));

    await worker.drainOnce();

    expect(service.markTransientFailure).toHaveBeenCalledWith('row-1', 'transient git error');
    expect(service.markRecoveryStarted).not.toHaveBeenCalled();
    expect(recoveryAgent.run).not.toHaveBeenCalled();
    expect(service.markNeedsAttention).not.toHaveBeenCalled();
    expect(feedback.send).not.toHaveBeenCalled();
  });

  it('exhausting transient budget spawns the recovery agent (within recovery budget)', async () => {
    // attempts = N_TRANSIENT - 1 → next attempt would equal N_TRANSIENT,
    // crossing the budget. recoveryAgentRuns=0 → still within recovery budget.
    const row = makeRow({ attempts: N_TRANSIENT - 1, recoveryAgentRuns: 0 });
    (service.claimNext as ReturnType<typeof vi.fn>).mockResolvedValueOnce(row);
    workflow.runPendingCommit.mockRejectedValueOnce(new Error('cannot push: needs human'));
    recoveryAgent.run.mockResolvedValueOnce(undefined);

    await worker.drainOnce();

    expect(service.markTransientFailure).not.toHaveBeenCalled();
    expect(service.markRecoveryStarted).toHaveBeenCalledWith('row-1');
    expect(recoveryAgent.run).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      branch: 'feat/x',
      path: 'Foo.md',
      lastError: 'cannot push: needs human',
      originalAuthorEmail: 'alice@example.com',
    });
    expect(service.markNeedsAttention).not.toHaveBeenCalled();
    expect(feedback.send).not.toHaveBeenCalled();
  });

  it('a recovery-agent crash does not abort the worker — the row stays pending for the next pass', async () => {
    const row = makeRow({ attempts: N_TRANSIENT - 1, recoveryAgentRuns: 0 });
    (service.claimNext as ReturnType<typeof vi.fn>).mockResolvedValueOnce(row);
    workflow.runPendingCommit.mockRejectedValueOnce(new Error('cannot push'));
    recoveryAgent.run.mockRejectedValueOnce(new Error('codemode wiring broken'));

    // No throw — the worker swallows the agent crash and moves on.
    await expect(worker.drainOnce()).resolves.toBeUndefined();
    // markRecoveryStarted still fired (we incremented the agent counter
    // for this attempt), so the row will hit needs_attention naturally
    // after N_RECOVERY tries.
    expect(service.markRecoveryStarted).toHaveBeenCalled();
    expect(service.markNeedsAttention).not.toHaveBeenCalled();
  });

  it('exhausting both budgets marks needs_attention and emits a system feedback notice', async () => {
    // attempts at the transient ceiling AND recovery already ran N_RECOVERY
    // times: nothing left to try. Escalate.
    const row = makeRow({
      attempts: N_TRANSIENT - 1,
      recoveryAgentRuns: N_RECOVERY,
    });
    (service.claimNext as ReturnType<typeof vi.fn>).mockResolvedValueOnce(row);
    workflow.runPendingCommit.mockRejectedValueOnce(new Error('unrecoverable'));

    await worker.drainOnce();

    expect(service.markNeedsAttention).toHaveBeenCalledWith('row-1', 'unrecoverable');
    expect(recoveryAgent.run).not.toHaveBeenCalled();
    expect(feedback.send).toHaveBeenCalledTimes(1);
    const call = (feedback.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.source).toBe('system');
    expect(call.user).toEqual(RECOVERY_BOT);
    // Body should carry enough context for an admin to investigate without
    // needing to consult the DB.
    expect(call.message).toContain('Terminal commit failure');
    expect(call.message).toContain('ws-1');
    expect(call.message).toContain('Foo.md');
    expect(call.message).toContain('unrecoverable');
    expect(call.message).toContain('alice@example.com');
  });

  it('a feedback-sink failure does not throw — the row stays needs_attention regardless', async () => {
    const row = makeRow({ attempts: N_TRANSIENT - 1, recoveryAgentRuns: N_RECOVERY });
    (service.claimNext as ReturnType<typeof vi.fn>).mockResolvedValueOnce(row);
    workflow.runPendingCommit.mockRejectedValueOnce(new Error('unrecoverable'));
    (feedback.send as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('feedback DB down'));

    await expect(worker.drainOnce()).resolves.toBeUndefined();
    expect(service.markNeedsAttention).toHaveBeenCalled();
  });

  /**
   * A sweep used to take exactly ONE row per workspace and then sleep
   * `POLL_INTERVAL_MS`, capping a workspace at ~2 commits/second however fast
   * git was. A bulk change — a migration, an agent run — paid a minute of
   * pure polling latency, and anything waiting for the queue to settle (a
   * change request being applied) waited with it.
   */
  describe('draining a burst', () => {
    /** Queue `count` rows, then nothing — the shape a bulk change leaves. */
    function queue(count: number) {
      const claim = service.claimNext as ReturnType<typeof vi.fn>;
      const ready = service.hasReadyRow as ReturnType<typeof vi.fn>;
      for (let i = 0; i < count; i += 1) {
        claim.mockResolvedValueOnce(makeRow({ id: `row-${i}`, path: `File${i}.md` }));
        // True until the last row is the one in hand.
        ready.mockResolvedValueOnce(i < count - 1);
      }
      claim.mockResolvedValue(null);
      ready.mockResolvedValue(false);
    }

    it('commits every queued row in ONE pass', async () => {
      queue(12);
      await worker.drainOnce();
      expect(workflow.runPendingCommit).toHaveBeenCalledTimes(12);
      expect(service.markSucceeded).toHaveBeenCalledTimes(12);
    });

    it('validates once — on the last commit, whose tree is the end state', async () => {
      // The validator parses the whole KB for a report that is only logged,
      // so per-file runs cost a full parse each and all say the same thing.
      queue(5);
      await worker.drainOnce();
      const skipped = workflow.runPendingCommit.mock.calls.map((c) => c[4]?.skipValidation);
      expect(skipped).toEqual([true, true, true, true, false]);
    });

    it('stops at the burst ceiling so one workspace cannot starve the rest', async () => {
      // The loop holds the single in-flight commit slot; an unbounded drain
      // would park every other user's save behind a huge migration.
      queue(200);
      await worker.drainOnce();
      expect(workflow.runPendingCommit).toHaveBeenCalledTimes(50);
    });

    it('gives up the pass the moment stop() lands mid-burst', async () => {
      queue(12);
      workflow.runPendingCommit.mockImplementation(async () => {
        (worker as unknown as { running: boolean }).running = false;
      });
      await worker.drainOnce();
      expect(workflow.runPendingCommit).toHaveBeenCalledTimes(1);
    });

    it('does not re-claim a row that just failed — the backoff gate holds', async () => {
      // `markTransientFailure` leaves `lastAttemptedAt` set, so `claimNext`
      // refuses the same row until its backoff elapses. Were that not true,
      // draining until empty would spin on a failing row.
      (service.claimNext as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(makeRow({ id: 'bad' }))
        .mockResolvedValue(null);
      workflow.runPendingCommit.mockRejectedValueOnce(new Error('push rejected'));

      await worker.drainOnce();

      expect(service.markTransientFailure).toHaveBeenCalledTimes(1);
      expect(workflow.runPendingCommit).toHaveBeenCalledTimes(1);
    });
  });
});

describe('PendingCommitsWorker lifecycle', () => {
  it('start() is idempotent; stop() awaits the in-flight pass without throwing', async () => {
    const worker = new PendingCommitsWorker({
      service: makeService(),
      workflow: { runPendingCommit: vi.fn() },
      recoveryAgent: { run: vi.fn() },
      feedback: makeFeedback(),
      workspaces: makeWorkspaces(),
      recoveryBot: RECOVERY_BOT,
      // Skip the real sleep so stop() returns immediately.
      sleep: () => Promise.resolve(),
    });
    worker.start();
    worker.start(); // second start is a no-op
    await expect(worker.stop()).resolves.toBeUndefined();
    await expect(worker.stop()).resolves.toBeUndefined(); // idempotent
  });
});
