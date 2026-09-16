import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { describe, it, expect, afterEach, vi } from 'vitest';
import type { AuthUser, IWorkflowService, WorkflowEvent } from '@bevel-software/platform-shared';
import type { IAccessControl } from '../../access/access-control.interface.js';
import type { AuthService } from '../../auth/auth.service.js';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import type { Database } from '../../database/connection.js';
import type { GitService } from '../git/git.service.js';
import type { PullRequestService } from '../git/pull-request.service.js';
import { PullRequestService as RealPullRequestService } from '../git/pull-request.service.js';
import type { IReviewWorkflowService } from '../review-workflow/review-workflow.interface.js';
import type { FileLockService } from '../file-lock.service.js';
import type { PendingCommitsService } from '../pending-commits.service.js';
import { WorkflowEventBus } from '../event-bus.js';
import { WorkflowService } from '../workflow.service.js';
import { createWorkflowRoutes } from '../workflow.routes.js';
import { WorkflowDomainError, WorkflowValidationError } from '../../../shared/domain-errors.js';

/**
 * A failed apply used to reach ONE person: the merge route answered the user
 * who clicked with a user-scoped `change-request-merge-failed`, and nothing
 * else anywhere recorded it. The request's author — the person actually
 * waiting on the verdict — saw it pending forever with no reason, and so did
 * every other owner. These tests pin the fix: the refusal is persisted on the
 * request, announced to every session, and read back through the summary.
 */

const ADMIN: AuthUser = { id: 'u-admin', email: 'admin@example.com', name: 'Ada Admin' } as AuthUser;

// ── The merge route ─────────────────────────────────────────────────────────

interface RouteHarness {
  server: Server;
  baseUrl: string;
  emitted: WorkflowEvent[];
  workflow: {
    getChangeRequestDetail: ReturnType<typeof vi.fn>;
    mergeChangeRequest: ReturnType<typeof vi.fn>;
    beginApplyAttempt: ReturnType<typeof vi.fn>;
    recordApplyFailure: ReturnType<typeof vi.fn>;
  };
}

async function routeHarness(merge: () => Promise<unknown>): Promise<RouteHarness> {
  const emitted: WorkflowEvent[] = [];
  const workflow = {
    getChangeRequestDetail: vi.fn(async () => ({
      headSha: 'h',
      approvals: [],
      state: 'open',
      title: 'Upload into Plugins/x',
      base: 'main',
    })),
    mergeChangeRequest: vi.fn(merge),
    beginApplyAttempt: vi.fn(() => 1),
    recordApplyFailure: vi.fn(async () => true),
  };
  const app = express();
  app.use(express.json());
  app.use('/api', (req, _res, next) => {
    (req as unknown as { userId: string }).userId = ADMIN.id;
    next();
  });
  app.use(
    '/api',
    createWorkflowRoutes(
      workflow as unknown as IWorkflowService,
      { getOrCreateForUser: vi.fn(async () => ({ id: 'ws-admin' })) } as unknown as WorkspaceService,
      { getUserById: vi.fn(async () => ADMIN) } as unknown as AuthService,
      { emit: (e: WorkflowEvent) => emitted.push(e) } as unknown as WorkflowEventBus,
      {} as unknown as IAccessControl,
      'knowledge-base',
    ),
  );
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${addr.port}`, emitted, workflow };
}

const closeServer = (s: Server) =>
  new Promise<void>((resolve, reject) => s.close((e) => (e ? reject(e) : resolve())));

describe('POST /workflow/change-requests/:n/merge — a failed apply reaches every viewer', () => {
  let h: RouteHarness | null = null;
  afterEach(async () => {
    if (h) await closeServer(h.server);
    h = null;
  });

  const post = (base: string) =>
    fetch(`${base}/api/workflow/change-requests/7/merge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });

  it('a gate refusal answers the clicker AND is persisted for everyone else', async () => {
    h = await routeHarness(async () => {
      // A domain error, like the gate's own `MergeBlockedError`: its message is
      // what the route reports (a bare Error would read "Internal server error").
      throw new WorkflowValidationError('Waiting on approval for Plugins/x/SKILL.md');
    });
    const res = await post(h.baseUrl);
    expect(res.status).toBe(202);

    await vi.waitFor(() => expect(h!.workflow.recordApplyFailure).toHaveBeenCalled());
    expect(h.workflow.recordApplyFailure).toHaveBeenCalledWith(
      7,
      { reason: expect.stringContaining('Waiting on approval'), conflicts: false, at: expect.any(Date) },
      ADMIN,
      1,
    );
    // The clicker's event and the persisted refusal name the same instant.
    const [, { at }] = h.workflow.recordApplyFailure.mock.calls[0] as [number, { at: Date }];
    // The clicker's own answer is unchanged.
    expect(h.emitted).toContainEqual(
      expect.objectContaining({
        kind: 'change-request-merge-failed',
        forUserId: ADMIN.id,
        number: 7,
        at: at.toISOString(),
      }),
    );
  });

  it('a refusal of the caller reaches the caller alone and erases nobody\'s verdict', async () => {
    h = await routeHarness(async () => {
      throw new WorkflowDomainError('Only admins can merge with bypass.', 403);
    });
    await post(h.baseUrl);
    await vi.waitFor(() =>
      expect(h!.emitted).toContainEqual(
        expect.objectContaining({ kind: 'change-request-merge-failed', forUserId: ADMIN.id }),
      ),
    );
    expect(h.workflow.recordApplyFailure).not.toHaveBeenCalled();
  });

  it('a conflict is persisted as a conflict', async () => {
    h = await routeHarness(async () => ({ kind: 'conflicts-need-resolution', conflictedPaths: ['a.md'] }));
    await post(h.baseUrl);
    await vi.waitFor(() => expect(h!.workflow.recordApplyFailure).toHaveBeenCalled());
    expect(h.workflow.recordApplyFailure).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ conflicts: true }),
      ADMIN,
      1,
    );
  });

  it('a landed apply records no failure', async () => {
    // Resolve a deferred merge and await the route's own settle, so the negative
    // assertion runs after the background attempt has finished — not after a
    // guessed sleep.
    let settled!: () => void;
    const done = new Promise<void>((r) => (settled = r));
    h = await routeHarness(async () => {
      queueMicrotask(settled);
      return { kind: 'merged', result: {} };
    });
    await post(h.baseUrl);
    await done;
    // One macrotask: the route's continuation after `mergeChangeRequest` resolves.
    await new Promise((r) => setImmediate(r));
    expect(h.workflow.mergeChangeRequest).toHaveBeenCalledTimes(1);
    expect(h.workflow.recordApplyFailure).not.toHaveBeenCalled();
    expect(h.emitted.filter((e) => e.kind === 'change-request-merge-failed')).toEqual([]);
  });

  it('the clicker still hears the refusal when persisting it fails', async () => {
    h = await routeHarness(async () => {
      throw new Error('gate says no');
    });
    h.workflow.recordApplyFailure.mockRejectedValue(new Error('db down'));
    await post(h.baseUrl);
    await vi.waitFor(() =>
      expect(h!.emitted).toContainEqual(expect.objectContaining({ kind: 'change-request-merge-failed' })),
    );
  });
});

// ── WorkflowService.recordApplyFailure ──────────────────────────────────────

function updateDb(openRows = 1) {
  const sets: Record<string, unknown>[] = [];
  const chain = {
    update: vi.fn(() => chain),
    set: vi.fn((values: Record<string, unknown>) => {
      sets.push(values);
      return chain;
    }),
    where: vi.fn(() => chain),
    returning: vi.fn(async () => Array.from({ length: openRows }, () => ({ number: 7 }))),
  };
  return { db: chain as unknown as Database, sets };
}

function service(db: Database, emit: (e: unknown) => void) {
  const prs = { invalidateDetailCache: vi.fn() };
  const svc = new WorkflowService(
    db,
    {} as GitService,
    prs as unknown as PullRequestService,
    {} as IReviewWorkflowService,
    {} as WorkspaceService,
    {} as IAccessControl,
    {} as FileLockService,
    {} as PendingCommitsService,
    'knowledge-base',
    { emit } as unknown as WorkflowEventBus,
  );
  return { svc, prs };
}

describe('WorkflowService — the persisted apply refusal', () => {
  it('records the reason, evicts the cached lists, and announces it to everyone without the text', async () => {
    const { db, sets } = updateDb();
    const emitted: unknown[] = [];
    const { svc, prs } = service(db, (e) => emitted.push(e));

    const recorded = await svc.recordApplyFailure(
      7,
      { reason: 'push failed: https://x-access-token:ghp_secret123@github.com/acme/kb', conflicts: false },
      ADMIN,
      svc.beginApplyAttempt(7),
    );
    expect(recorded).toBe(true);

    expect(sets[0]).toMatchObject({ applyFailureConflicts: false, applyFailedByName: 'Ada Admin' });
    expect(sets[0]!.applyFailedAt).toBeInstanceOf(Date);
    // Persisted text is redacted like every other stored git error.
    expect(String(sets[0]!.applyFailureReason)).not.toContain('ghp_secret123');
    expect(prs.invalidateDetailCache).toHaveBeenCalledWith(7);
    expect(emitted).toEqual([{ kind: 'change-request-apply-failed', number: 7 }]);
  });

  it('keeps a long gate refusal whole enough to name the files', async () => {
    const { db, sets } = updateDb();
    const { svc } = service(db, () => {});
    const reason = `Waiting on approval for ${Array.from({ length: 12 }, (_, i) => `Plugins/x/file-${i}.md`).join(', ')}`;
    expect(reason.length).toBeGreaterThan(200);
    await svc.recordApplyFailure(7, { reason, conflicts: false }, ADMIN, svc.beginApplyAttempt(7));
    expect(sets[0]!.applyFailureReason).toBe(reason);
  });

  it('an older attempt finishing last does not overwrite the newer attempt\'s refusal', async () => {
    const { db, sets } = updateDb();
    const emitted: unknown[] = [];
    const { svc } = service(db, (e) => emitted.push(e));
    const older = svc.beginApplyAttempt(7);
    const newer = svc.beginApplyAttempt(7);
    expect(await svc.recordApplyFailure(7, { reason: 'newer', conflicts: false }, ADMIN, newer)).toBe(true);
    expect(await svc.recordApplyFailure(7, { reason: 'older', conflicts: false }, ADMIN, older)).toBe(false);
    expect(sets.map((v) => v.applyFailureReason)).toEqual(['newer']);
    expect(emitted).toHaveLength(1);
  });

  it('a request a concurrent apply already landed announces no failure', async () => {
    const { db } = updateDb(0);
    const emitted: unknown[] = [];
    const { svc, prs } = service(db, (e) => emitted.push(e));
    const recorded = await svc.recordApplyFailure(
      7,
      { reason: 'already merged', conflicts: false },
      ADMIN,
      svc.beginApplyAttempt(7),
    );
    expect(recorded).toBe(false);
    expect(emitted).toEqual([]);
    expect(prs.invalidateDetailCache).not.toHaveBeenCalled();
  });
});

// ── Event scope ─────────────────────────────────────────────────────────────

describe('change-request-apply-failed on the bus', () => {
  it('reaches every session — the author and other viewers, not only the clicker', () => {
    const bus = new WorkflowEventBus();
    const sub = (sessionId: string, userId: string) => ({
      sessionId,
      userId,
      getFocusedWorkspaceIds: () => [],
      push: vi.fn(),
    });
    const clicker = sub('s-admin', 'u-admin');
    const author = sub('s-author', 'u-author');
    const viewer = sub('s-viewer', 'u-viewer');
    for (const s of [clicker, author, viewer]) bus.subscribe(s as never);

    bus.emit({ kind: 'change-request-apply-failed', number: 7 });

    expect(clicker.push).toHaveBeenCalledTimes(1);
    expect(author.push).toHaveBeenCalledTimes(1);
    expect(viewer.push).toHaveBeenCalledTimes(1);
  });
});

// ── Read back through the summary ───────────────────────────────────────────

describe('PullRequestService — lastApplyFailure on the request', () => {
  const ROW = {
    id: 'cr-7',
    number: 7,
    sourceBranch: 'bo/suggestions',
    targetBranch: 'main',
    title: 'Upload into Plugins/x',
    body: '',
    authorEmail: 'bo@example.com',
    authorName: 'Bo Business',
    state: 'open',
    mergedSha: null,
    applyFailureReason: 'Waiting on approval for Plugins/x/SKILL.md',
    applyFailureConflicts: false,
    applyFailedAt: new Date('2026-09-16T10:00:00Z'),
    applyFailedByName: 'Ada Admin',
    createdAt: new Date('2026-09-16T09:00:00Z'),
    updatedAt: null,
    closedAt: null,
  };

  function detailFor(row: Record<string, unknown>) {
    const db = {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [row] }) }) }),
    } as unknown as Database;
    const git = {
      resolvePrShas: async () => ({ baseSha: 'b', headSha: 'h' }),
      changedFilesForPr: async () => [],
    } as unknown as GitService;
    const svc = new RealPullRequestService(
      db,
      { findAnyWorkspaceId: async () => 'ws' } as unknown as WorkspaceService,
      { canWriteAtRef: async () => false } as unknown as IAccessControl,
      git,
    );
    return svc.getPrDetail(7, { fresh: true });
  }

  it('an open request carries the refusal to whoever reads it', async () => {
    const detail = await detailFor(ROW);
    expect(detail?.lastApplyFailure).toEqual({
      reason: 'Waiting on approval for Plugins/x/SKILL.md',
      conflicts: false,
      at: '2026-09-16T10:00:00.000Z',
      byName: 'Ada Admin',
    });
  });

  it('a request that has since landed reports none', async () => {
    const detail = await detailFor({ ...ROW, state: 'merged' });
    expect(detail?.lastApplyFailure).toBeNull();
  });

  it('a row with no refusal reports none', async () => {
    const detail = await detailFor({ ...ROW, applyFailureReason: null, applyFailedAt: null });
    expect(detail?.lastApplyFailure).toBeNull();
  });
});

describe('PullRequestService — a read the refusal overtook is not cached', () => {
  it('a detail read that started before recordApplyFailure cannot republish the old row', async () => {
    const before = { number: 7, state: 'open', targetBranch: 'main', sourceBranch: 'b', title: 't', body: '',
      authorEmail: 'bo@example.com', authorName: 'Bo', createdAt: new Date(), applyFailureReason: null, applyFailedAt: null };
    const after = { ...before, applyFailureReason: 'gate says no', applyFailedAt: new Date(), applyFailedByName: 'Ada' };
    let current: Record<string, unknown> = before;
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((r) => (releaseFirst = r));
    let reads = 0;
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => {
              const row = current;
              if (reads++ === 0) await firstHeld;
              return [row];
            },
          }),
        }),
      }),
    } as unknown as Database;
    const svc = new RealPullRequestService(
      db,
      { findAnyWorkspaceId: async () => 'ws' } as unknown as WorkspaceService,
      { canWriteAtRef: async () => false } as unknown as IAccessControl,
      { resolvePrShas: async () => ({ baseSha: 'b', headSha: 'h' }), changedFilesForPr: async () => [] } as unknown as GitService,
    );

    const stale = svc.getPrDetail(7, { viewerEmail: 'bo@example.com' });
    // The refusal lands while that read is still in flight.
    current = after;
    svc.invalidateDetailCache(7);
    releaseFirst();
    expect((await stale)?.lastApplyFailure).toBeNull();

    const next = await svc.getPrDetail(7, { viewerEmail: 'bo@example.com' });
    expect(next?.lastApplyFailure?.reason).toBe('gate says no');
  });
});
