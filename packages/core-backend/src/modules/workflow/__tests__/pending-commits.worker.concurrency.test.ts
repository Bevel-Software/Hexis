import { describe, it, expect, vi } from 'vitest';
import type { ISystemNoticeSink, RecoveryAgentRunner } from '../pending-commits.worker.js';
import { PendingCommitsWorker } from '../pending-commits.worker.js';
import type { PendingCommit, PendingCommitsService } from '../pending-commits.service.js';

/**
 * How the worker spreads its work ACROSS workspaces — the one property the
 * per-row decision tree (see the sibling suite) says nothing about. Driven
 * through `drainOnce()` like that suite, with commits the test holds open so
 * that "in flight at the same time" is observable rather than inferred.
 */

const RECOVERY_BOT = { id: 'recovery-bot-id', email: 'recovery-bot@bevel.local', name: 'Recovery Bot' };

function row(workspaceId: string, id = `row-${workspaceId}`): PendingCommit {
  return {
    id,
    workspaceId,
    branch: 'feat/x',
    path: 'Foo.md',
    authorEmail: 'alice@example.com',
    authorName: 'Alice',
    queuedAt: new Date('2026-01-01T00:00:00Z'),
    status: 'running',
    attempts: 0,
    recoveryAgentRuns: 0,
    lastAttemptedAt: null,
    lastError: null,
  };
}

/** A queue holding one row per listed workspace, handed out once each. */
function queueWith(rows: PendingCommit[]) {
  const pending = new Map(rows.map((r) => [r.workspaceId, r]));
  const service = {
    enqueue: vi.fn(),
    claimNext: vi.fn(async (workspaceId: string) => {
      const next = pending.get(workspaceId) ?? null;
      pending.delete(workspaceId);
      return next;
    }),
    hasReadyRow: vi.fn().mockResolvedValue(false),
    markSucceeded: vi.fn().mockResolvedValue(undefined),
    markTransientFailure: vi.fn().mockResolvedValue(undefined),
    markRecoveryStarted: vi.fn().mockResolvedValue(undefined),
    markNeedsAttention: vi.fn().mockResolvedValue(undefined),
  } as unknown as PendingCommitsService & { markSucceeded: ReturnType<typeof vi.fn>; claimNext: ReturnType<typeof vi.fn> };
  return service;
}

/** Commits that finish only when the test says so, and count how many are open. */
function heldCommits() {
  const open = new Map<string, () => void>();
  let inFlight = 0;
  let peak = 0;
  const workflow = {
    runPendingCommit: vi.fn(
      (workspaceId: string) =>
        new Promise<void>((resolve) => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          open.set(workspaceId, () => {
            inFlight -= 1;
            resolve();
          });
        }),
    ),
  };
  return {
    workflow,
    release: (workspaceId: string) => open.get(workspaceId)?.(),
    releaseAll: () => [...open.keys()].forEach((id) => open.get(id)?.()),
    get inFlight() {
      return inFlight;
    },
    get peak() {
      return peak;
    },
  };
}

function makeWorker(
  service: PendingCommitsService,
  workflow: { runPendingCommit: ReturnType<typeof vi.fn> },
  workspaceIds: string[],
): PendingCommitsWorker {
  const worker = new PendingCommitsWorker({
    service,
    workflow: workflow as never,
    recoveryAgent: { run: vi.fn() } as unknown as RecoveryAgentRunner,
    feedback: { send: vi.fn() } as unknown as ISystemNoticeSink,
    workspaces: { knownWorkspaces: () => workspaceIds.map((id) => ({ id, branch: 'feat/x' })) },
    recoveryBot: RECOVERY_BOT,
    now: () => new Date('2026-01-01T00:01:00Z'),
  });
  // Same seam the sibling suite uses: the single-pass drain without the loop.
  (worker as unknown as { running: boolean }).running = true;
  return worker;
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('PendingCommitsWorker.drainOnce across workspaces', () => {
  it('a workspace whose remote has stalled does not delay another workspace', async () => {
    const service = queueWith([row('ws-stalled'), row('ws-fine')]);
    const commits = heldCommits();
    const worker = makeWorker(service, commits.workflow, ['ws-stalled', 'ws-fine']);

    const pass = worker.drainOnce();
    await settle();
    // Both are in flight: the stalled one has not been allowed to block the other.
    expect(commits.inFlight).toBe(2);

    commits.release('ws-fine');
    await settle();
    // The fine workspace's row landed while the stalled one is still pushing.
    expect(service.markSucceeded).toHaveBeenCalledWith('row-ws-fine');
    expect(service.markSucceeded).not.toHaveBeenCalledWith('row-ws-stalled');

    commits.release('ws-stalled');
    await pass;
    expect(service.markSucceeded).toHaveBeenCalledWith('row-ws-stalled');
  });

  it('never drains one clone under two spellings at once', async () => {
    // A route hands the worker the decoded form, a directory listing the
    // encoded one. They are one workspace, one clone, and one drain.
    const service = queueWith([]);
    const commits = heldCommits();
    const worker = makeWorker(service, commits.workflow, ['alice/feature', 'alice%2Ffeature']);

    await worker.drainOnce();

    expect(service.claimNext).toHaveBeenCalledTimes(1);
    expect(service.claimNext).toHaveBeenCalledWith('alice%2Ffeature', expect.any(Date));
  });

  it('bounds how many workspaces drain at once, and gets to all of them', async () => {
    const ids = ['ws-1', 'ws-2', 'ws-3', 'ws-4', 'ws-5', 'ws-6'];
    const service = queueWith(ids.map((id) => row(id)));
    const commits = heldCommits();
    const worker = makeWorker(service, commits.workflow, ids);

    const pass = worker.drainOnce();
    await settle();
    expect(commits.inFlight).toBe(4);

    // Finishing one admits the next; the ceiling holds throughout.
    commits.release('ws-1');
    await settle();
    expect(commits.inFlight).toBe(4);
    expect(commits.peak).toBe(4);

    commits.releaseAll();
    await settle();
    commits.releaseAll();
    await pass;
    for (const id of ids) expect(service.markSucceeded).toHaveBeenCalledWith(`row-${id}`);
    expect(commits.peak).toBe(4);
  });

  it('within one workspace, rows still land one after another', async () => {
    // Two rows for one workspace: the second is claimed only after the first
    // has finished, because they share a clone.
    const first = row('ws-1', 'row-a');
    const second = row('ws-1', 'row-b');
    const rows = [first, second];
    const service = queueWith([]);
    (service.claimNext as ReturnType<typeof vi.fn>).mockImplementation(async () => rows.shift() ?? null);
    (service.hasReadyRow as ReturnType<typeof vi.fn>).mockImplementation(async () => rows.length > 0);
    const commits = heldCommits();
    const worker = makeWorker(service, commits.workflow, ['ws-1']);

    const pass = worker.drainOnce();
    await settle();
    expect(commits.inFlight).toBe(1);

    commits.release('ws-1');
    await settle();
    expect(commits.workflow.runPendingCommit).toHaveBeenCalledTimes(2);

    commits.release('ws-1');
    await pass;
    expect(service.markSucceeded).toHaveBeenCalledWith('row-a');
    expect(service.markSucceeded).toHaveBeenCalledWith('row-b');
  });
});
