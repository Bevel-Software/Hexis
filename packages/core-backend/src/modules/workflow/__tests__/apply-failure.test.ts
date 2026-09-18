import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { describe, it, expect, afterEach, vi } from 'vitest';
import type { AuthUser, FileApprovalState, IWorkflowService, WorkflowEvent } from '@bevel-software/platform-shared';
import type { IAccessControl } from '../../access/access-control.interface.js';
import type { AuthService } from '../../auth/auth.service.js';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import type { Database } from '../../database/connection.js';
import type { GitService } from '../git/git.service.js';
import type { PullRequestService } from '../git/pull-request.service.js';
import { PullRequestService as RealPullRequestService } from '../git/pull-request.service.js';
import type { IReviewWorkflowService } from '../review-workflow/review-workflow.interface.js';
import { ReviewWorkflowService } from '../review-workflow/review-workflow.service.js';
import type { FileLockService } from '../file-lock.service.js';
import type { PendingCommitsService } from '../pending-commits.service.js';
import { WorkflowEventBus } from '../event-bus.js';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { changeRequests } from '../../database/schema.js';
import { coreMigrationsDir } from '../../../assets.js';
import { WorkflowService } from '../workflow.service.js';
import { APPLY_FAILURE_REASON_WITHHELD, createWorkflowRoutes } from '../workflow.routes.js';
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
    endApplyAttempt: ReturnType<typeof vi.fn>;
    recordApplyFailure: ReturnType<typeof vi.fn>;
  };
}

async function routeHarness(
  merge: () => Promise<unknown>,
  opts: {
    touchedNodePaths?: string[];
    canReadBatch?: (paths: string[]) => Promise<Map<string, boolean>>;
  } = {},
): Promise<RouteHarness> {
  const emitted: WorkflowEvent[] = [];
  const canReadBatch = opts.canReadBatch ?? (async (paths: string[]) => new Map(paths.map((p) => [p, true])));
  const workflow = {
    getChangeRequestDetail: vi.fn(async () => ({
      headSha: 'h',
      approvals: [],
      state: 'open',
      title: 'Upload into Plugins/x',
      base: 'main',
      touchedNodePaths: opts.touchedNodePaths ?? ['Plugins/x/SKILL.md'],
    })),
    mergeChangeRequest: vi.fn(merge),
    beginApplyAttempt: vi.fn(() => 1),
    endApplyAttempt: vi.fn(),
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
      {
        canReadBatch: async (_ws: string, _email: string, paths: string[]) => canReadBatch(paths),
      } as unknown as IAccessControl,
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
      // The gate's own `MergeBlockedError` shape: a 422 carrying the reasons it
      // still waits on. Its message is what the route reports.
      throw new WorkflowDomainError('Merge gate rejected: Waiting on approval for Plugins/x/SKILL.md', 422, {
        mergeBlockedReasons: ['Waiting on approval for Plugins/x/SKILL.md'],
      });
    });
    const res = await post(h.baseUrl);
    expect(res.status).toBe(202);

    await vi.waitFor(() => expect(h!.workflow.recordApplyFailure).toHaveBeenCalled());
    expect(h.workflow.recordApplyFailure).toHaveBeenCalledWith(
      7,
      { reason: expect.stringContaining('Waiting on approval'), kind: 'gate', at: expect.any(Date) },
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

  it("the clicker's own answer is scoped like the stored one: a clicker who cannot read the files gets no reason", async () => {
    h = await routeHarness(
      async () => {
        throw new WorkflowValidationError('Waiting on approval for Plugins/x/SKILL.md');
      },
      { canReadBatch: async (paths) => new Map(paths.map((p) => [p, false])) },
    );
    await post(h.baseUrl);
    await vi.waitFor(() => expect(h!.workflow.recordApplyFailure).toHaveBeenCalled());
    const answer = h.emitted.find((e) => e.kind === 'change-request-merge-failed') as { reason: string };
    expect(answer.reason).toBe(APPLY_FAILURE_REASON_WITHHELD);
    // The raw reason is still what is stored, for the viewers who may read it.
    expect(h.workflow.recordApplyFailure).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ reason: expect.stringContaining('Plugins/x/SKILL.md') }),
      ADMIN,
      1,
    );
  });

  it("a request with no resolved touched paths withholds the clicker's reason too", async () => {
    h = await routeHarness(
      async () => {
        throw new WorkflowValidationError('Waiting on approval for Plugins/x/SKILL.md');
      },
      { touchedNodePaths: [] },
    );
    await post(h.baseUrl);
    await vi.waitFor(() =>
      expect(h!.emitted).toContainEqual(expect.objectContaining({ kind: 'change-request-merge-failed' })),
    );
    const answer = h.emitted.find((e) => e.kind === 'change-request-merge-failed') as { reason: string };
    expect(answer.reason).toBe(APPLY_FAILURE_REASON_WITHHELD);
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

  it('any other refusal is persisted as an error, which an approval does not answer', async () => {
    h = await routeHarness(async () => {
      throw new WorkflowDomainError('Merge failed: push rejected', 502);
    });
    await post(h.baseUrl);
    await vi.waitFor(() => expect(h!.workflow.recordApplyFailure).toHaveBeenCalled());
    expect(h.workflow.recordApplyFailure).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ kind: 'error' }),
      ADMIN,
      1,
    );
  });

  it('a conflict is persisted as a conflict', async () => {
    h = await routeHarness(async () => ({ kind: 'conflicts-need-resolution', conflictedPaths: ['a.md'] }));
    await post(h.baseUrl);
    await vi.waitFor(() => expect(h!.workflow.recordApplyFailure).toHaveBeenCalled());
    expect(h.workflow.recordApplyFailure).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ kind: 'conflicts' }),
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
    // The attempt ended, so the service holds no entry for it.
    expect(h.workflow.endApplyAttempt).toHaveBeenCalledWith(7, 1);
  });

  it('a failed attempt ends too, after its refusal is recorded', async () => {
    h = await routeHarness(async () => {
      throw new WorkflowValidationError('gate says no');
    });
    await post(h.baseUrl);
    await vi.waitFor(() => expect(h!.workflow.endApplyAttempt).toHaveBeenCalledWith(7, 1));
    expect(h.workflow.recordApplyFailure.mock.invocationCallOrder[0]).toBeLessThan(
      h.workflow.endApplyAttempt.mock.invocationCallOrder[0]!,
    );
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

/** The SQL a drizzle condition renders to, so a test can read what the write is conditioned on. */
type Row = Record<string, unknown>;

/**
 * Whether a drizzle condition holds for `row` (keyed by column name), by
 * evaluating the SQL it renders to. Covers exactly the operators these writes
 * use — `=`, `<`, `is [not] null`, `in (…)`, `and`, `or` — and throws on
 * anything else, so a predicate this cannot read fails the test instead of
 * silently matching.
 */
function holds(condition: SQL, row: Row): boolean {
  const { sql, params, typings } = new PgDialect().sqlToQuery(condition);
  const value = (v: unknown) => (v instanceof Date ? v.getTime() : v);
  const param = (i: number) =>
    typings?.[i] === 'timestamp' ? Date.parse(String(params[i])) : value(params[i]);
  const cols: unknown[] = [];
  let expr = sql
    .replace(/"change_requests"\."(\w+)"/g, (_m, col: string) => `c[${cols.push(value(row[col])) - 1}]`)
    .replace(/\$(\d+)/g, (_m, n: string) => `p[${Number(n) - 1}]`)
    .replace(/(c\[\d+\]) is not null/g, '($1 != null)')
    .replace(/(c\[\d+\]) is null/g, '($1 == null)')
    .replace(/(c\[\d+\]) in \(([^)]*)\)/g, '[$2].includes($1)')
    .replace(/ = /g, ' === ')
    .replace(/ and /g, ' && ')
    .replace(/ or /g, ' || ');
  if (!/^[\s()\[\]cp\d=!<&|,.a-z]*$/.test(expr.replace(/includes/g, ''))) {
    throw new Error(`holds(): unsupported predicate: ${sql}`);
  }
  const p = params.map((_v, i) => param(i));
  return new Function('c', 'p', `return ${expr};`)(cols, p) as boolean;
}

/**
 * A one-row `change_requests` that honours the WHERE of every UPDATE — the
 * row changes only when the condition holds for it, and `returning()` answers
 * as the database would. A double that ignored the predicate could not tell a
 * kind- or time-scoped clear from one that wipes everything.
 */
function rowDb(seed: Partial<Row> = {}) {
  const row: Row = {
    number: 7,
    state: 'open',
    apply_failure_reason: null,
    apply_failure_conflicts: null,
    apply_failed_at: null,
    apply_failed_by_name: null,
    apply_failure_kind: null,
    ...seed,
  };
  const writes: Row[] = [];
  let pendingSet: Row = {};
  let pendingWhere: SQL | undefined;
  const chain = {
    update: () => chain,
    set: (values: Row) => {
      pendingSet = values;
      return chain;
    },
    where: (condition: SQL) => {
      pendingWhere = condition;
      return chain;
    },
    returning: async () => {
      if (!pendingWhere || !holds(pendingWhere, row)) return [];
      for (const [key, v] of Object.entries(pendingSet)) {
        row[(changeRequests as unknown as Record<string, { name: string }>)[key]!.name] = v;
      }
      writes.push(pendingSet);
      return [{ number: row.number }];
    },
  };
  return { db: chain as unknown as Database, row, writes };
}

/** A stored refusal of `kind`, recorded at `at`. */
const refusal = (kind: 'gate' | 'conflicts' | 'error', at: Date): Partial<Row> => ({
  apply_failure_reason: `${kind} reason`,
  apply_failure_conflicts: kind === 'conflicts',
  apply_failed_at: at,
  apply_failed_by_name: 'Ada Admin',
  apply_failure_kind: kind,
});

function service(
  db: Database,
  emit: (e: unknown) => void,
  reviewWorkflow: Partial<IReviewWorkflowService> = {},
  deps: { git?: Partial<GitService>; prs?: Record<string, unknown> } = {},
) {
  const prs = { invalidateDetailCache: vi.fn(), ...deps.prs };
  const svc = new WorkflowService(
    db,
    (deps.git ?? {}) as GitService,
    prs as unknown as PullRequestService,
    reviewWorkflow as IReviewWorkflowService,
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
      { reason: 'push failed: https://x-access-token:ghp_secret123@github.com/acme/kb', kind: 'error' },
      ADMIN,
      svc.beginApplyAttempt(7),
    );
    expect(recorded).toBe(true);

    expect(sets[0]).toMatchObject({
      applyFailureConflicts: false,
      applyFailureKind: 'error',
      applyFailedByName: 'Ada Admin',
    });
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
    await svc.recordApplyFailure(7, { reason, kind: 'error' }, ADMIN, svc.beginApplyAttempt(7));
    expect(sets[0]!.applyFailureReason).toBe(reason);
  });

  it('an older attempt finishing last does not overwrite the newer attempt\'s refusal', async () => {
    const { db, sets } = updateDb();
    const emitted: unknown[] = [];
    const { svc } = service(db, (e) => emitted.push(e));
    const older = svc.beginApplyAttempt(7);
    const newer = svc.beginApplyAttempt(7);
    expect(await svc.recordApplyFailure(7, { reason: 'newer', kind: 'error' }, ADMIN, newer)).toBe(true);
    expect(await svc.recordApplyFailure(7, { reason: 'older', kind: 'error' }, ADMIN, older)).toBe(false);
    expect(sets.map((v) => v.applyFailureReason)).toEqual(['newer']);
    expect(emitted).toHaveLength(1);
  });

  it('an ended attempt records nothing, and a token is never reissued', async () => {
    const { db, sets } = updateDb();
    const emitted: unknown[] = [];
    const { svc } = service(db, (e) => emitted.push(e));

    const ended = svc.beginApplyAttempt(7);
    svc.endApplyAttempt(7, ended);
    expect(await svc.recordApplyFailure(7, { reason: 'ended', kind: 'error' }, ADMIN, ended)).toBe(false);

    // A running attempt, then a newer one that ends first: the older one finds
    // nothing to match and records nothing — even with a third attempt started
    // after the newer one's entry left.
    const older = svc.beginApplyAttempt(7);
    const newer = svc.beginApplyAttempt(7);
    svc.endApplyAttempt(7, newer);
    const third = svc.beginApplyAttempt(7);
    // Never reissued: every token handed out is distinct, including the one
    // issued after an earlier attempt on the same request ended.
    expect(new Set([ended, older, newer, third]).size).toBe(4);
    expect(await svc.recordApplyFailure(7, { reason: 'older', kind: 'error' }, ADMIN, older)).toBe(false);
    svc.endApplyAttempt(7, older);
    expect(sets).toEqual([]);
    expect(emitted).toEqual([]);

    // Ending the stale token left the current attempt able to record.
    expect(await svc.recordApplyFailure(7, { reason: 'third', kind: 'error' }, ADMIN, third)).toBe(true);
    expect(sets.map((v) => v.applyFailureReason)).toEqual(['third']);
  });

  it('the write itself never replaces a newer refusal — an older instant loses even past the in-process guard', async () => {
    // A newer refusal is already stored (another replica, or an UPDATE that
    // landed first). The in-process guard passes this attempt; the row must not.
    const newer = new Date('2026-09-16T10:05:00Z');
    const store = rowDb(refusal('gate', newer));
    const emitted: unknown[] = [];
    const { svc } = service(store.db, (e) => emitted.push(e));
    const older = new Date('2026-09-16T10:00:00Z');
    const recorded = await svc.recordApplyFailure(
      7,
      { reason: 'older', kind: 'error', at: older },
      ADMIN,
      svc.beginApplyAttempt(7),
    );
    expect(recorded).toBe(false);
    expect(store.row).toMatchObject({ apply_failure_reason: 'gate reason', apply_failed_at: newer });
    expect(emitted).toEqual([]);

    // …while a newer instant does replace it, and a closed request takes none.
    const later = new Date('2026-09-16T10:10:00Z');
    expect(
      await svc.recordApplyFailure(7, { reason: 'later', kind: 'error', at: later }, ADMIN, svc.beginApplyAttempt(7)),
    ).toBe(true);
    expect(store.row.apply_failure_reason).toBe('later');
    store.row.state = 'merged';
    expect(
      await svc.recordApplyFailure(
        7,
        { reason: 'after merge', kind: 'error', at: new Date('2026-09-16T10:20:00Z') },
        ADMIN,
        svc.beginApplyAttempt(7),
      ),
    ).toBe(false);
    expect(store.row.apply_failure_reason).toBe('later');
  });

  it('a request a concurrent apply already landed announces no failure', async () => {
    const { db } = updateDb(0);
    const emitted: unknown[] = [];
    const { svc, prs } = service(db, (e) => emitted.push(e));
    const recorded = await svc.recordApplyFailure(
      7,
      { reason: 'already merged', kind: 'error' },
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

describe('WorkflowService — a refusal clears when a change makes it obsolete', () => {
  const approveArgs = [7, 'Plugins/x/SKILL.md', ADMIN, [], 'h', 'main', null, 'ws'] as const;
  const EARLIER = new Date(Date.now() - 60_000);

  /** A gate-bound markdown file's approval state, as the review workflow returns it. */
  const fileState = (path: string, isApproved: boolean): FileApprovalState => ({
    path,
    eligibleApprovers: { roles: ['Plugin owners'], users: [] },
    approvedBy: [],
    isApproved,
    inMergeGate: true,
  } as unknown as FileApprovalState);
  const ALL_APPROVED = [fileState('Plugins/x/SKILL.md', true), fileState('Plugins/x/notes.md', true)];

  function approving(
    seed: Partial<Row>,
    onApprove: (row: Row) => void = () => {},
    approvalsAfter: FileApprovalState[] = ALL_APPROVED,
  ) {
    const store = rowDb(seed);
    const emitted: { kind: string }[] = [];
    const { svc, prs } = service(store.db, (e) => emitted.push(e as { kind: string }), {
      approveFile: vi.fn(async () => {
        onApprove(store.row);
        return approvalsAfter;
      }),
      // The real gate: whether an approval answers the refusal is its verdict.
      evaluateMergeGate: (input) => ReviewWorkflowService.prototype.evaluateMergeGate.call({}, input),
    });
    return { ...store, svc, prs, emitted };
  }

  function movingHead(seed: Partial<Row>, onMerge: (row: Row) => void = () => {}) {
    const store = rowDb(seed);
    const emitted: { kind: string }[] = [];
    const { svc } = service(
      store.db,
      (e) => emitted.push(e as { kind: string }),
      {},
      {
        git: {
          pull: vi.fn(async () => ({ treeChanged: false })),
          mergeFromOrigin: vi.fn(async () => {
            onMerge(store.row);
            return { kind: 'merged', alreadyUpToDate: false };
          }),
          push: vi.fn(async () => undefined),
        } as unknown as Partial<GitService>,
        prs: {
          getPrDetail: vi.fn(async () => ({ state: 'open', branch: 'bo/suggestions', base: 'main', viewerCanUpdate: true })),
        },
      },
    );
    return { ...store, svc, emitted };
  }

  it('approving ONE of several waiting files leaves the gate refusal naming the others', async () => {
    const t = approving(refusal('gate', EARLIER), () => {}, [
      fileState('Plugins/x/SKILL.md', true),
      fileState('Plugins/x/notes.md', false),
    ]);
    await t.svc.approveFile(...approveArgs);
    expect(t.row).toMatchObject({ apply_failure_kind: 'gate', apply_failure_reason: 'gate reason' });
    expect(t.writes).toEqual([]);
    expect(t.emitted.map((e) => e.kind)).toEqual(['approval-changed']);
  });

  it('an approval clears a GATE refusal recorded before it, once the gate would pass, and tells every viewer to re-read', async () => {
    const t = approving(refusal('gate', EARLIER));
    await t.svc.approveFile(...approveArgs);
    expect(t.row).toMatchObject({
      apply_failure_reason: null,
      apply_failure_conflicts: null,
      apply_failed_at: null,
      apply_failed_by_name: null,
      apply_failure_kind: null,
    });
    expect(t.prs.invalidateDetailCache).toHaveBeenCalledWith(7);
    expect(t.emitted.map((e) => e.kind)).toEqual(['change-request-apply-failed', 'approval-changed']);
  });

  it.each(['conflicts', 'error'] as const)(
    'an approval leaves a %s refusal stored, and announces only itself',
    async (kind) => {
      const t = approving(refusal(kind, EARLIER));
      await t.svc.approveFile(...approveArgs);
      expect(t.row).toMatchObject({ apply_failure_kind: kind, apply_failure_reason: `${kind} reason` });
      expect(t.writes).toEqual([]);
      expect(t.emitted.map((e) => e.kind)).toEqual(['approval-changed']);
      // Only the approval's own invalidation ran, none for a cleared refusal.
      expect(t.prs.invalidateDetailCache).toHaveBeenCalledTimes(1);
    },
  );

  it('a gate refusal recorded WHILE the approval was landing is newer than it and stays', async () => {
    const t = approving({}, (row) => Object.assign(row, refusal('gate', new Date(Date.now() + 1_000))));
    await t.svc.approveFile(...approveArgs);
    expect(t.row.apply_failure_reason).toBe('gate reason');
    expect(t.emitted.map((e) => e.kind)).toEqual(['approval-changed']);
  });

  it('a moved source head clears a refusal of ANY kind recorded before it', async () => {
    const t = movingHead(refusal('conflicts', EARLIER));
    await t.svc.updateFromTarget('bo%2Fsuggestions', ADMIN, 7);
    expect(t.row.apply_failure_reason).toBeNull();
    expect(t.row.apply_failure_kind).toBeNull();
    expect(t.emitted.map((e) => e.kind)).toContain('change-request-apply-failed');
  });

  it('a refusal recorded while the head was moving is newer than the move and stays', async () => {
    const t = movingHead({}, (row) => Object.assign(row, refusal('error', new Date(Date.now() + 1_000))));
    await t.svc.updateFromTarget('bo%2Fsuggestions', ADMIN, 7);
    expect(t.row.apply_failure_reason).toBe('error reason');
    expect(t.emitted.map((e) => e.kind)).not.toContain('change-request-apply-failed');
  });

  it('with no refusal recorded, an approval announces only itself', async () => {
    const t = approving({});
    await t.svc.approveFile(...approveArgs);
    expect(t.writes).toEqual([]);
    expect(t.emitted.map((e) => e.kind)).toEqual(['approval-changed']);
  });

  it('a gate that cannot be re-evaluated keeps the refusal and never fails the approval', async () => {
    const store = rowDb(refusal('gate', EARLIER));
    const { svc } = service(store.db, () => {}, {
      approveFile: vi.fn(async () => ALL_APPROVED),
      evaluateMergeGate: () => {
        throw new Error('gate unavailable');
      },
    });
    await expect(svc.approveFile(...approveArgs)).resolves.toEqual(ALL_APPROVED);
    expect(store.row.apply_failure_reason).toBe('gate reason');
  });

  it('a failed clear never fails the approval that triggered it', async () => {
    const db = {
      update: () => {
        throw new Error('db down');
      },
    } as unknown as Database;
    const { svc } = service(db, () => {}, {
      approveFile: vi.fn(async () => ALL_APPROVED),
      evaluateMergeGate: (input) => ReviewWorkflowService.prototype.evaluateMergeGate.call({}, input),
    });
    await expect(svc.approveFile(...approveArgs)).resolves.toEqual(ALL_APPROVED);
  });
});

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
      forkPointForPr: async () => ({ mergeBaseSha: 'b', behind: false }),
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
      {
        resolvePrShas: async () => ({ baseSha: 'b', headSha: 'h' }),
        changedFilesForPr: async () => [],
        forkPointForPr: async () => ({ mergeBaseSha: 'b', behind: false }),
      } as unknown as GitService,
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

// ── Who reads the reason ────────────────────────────────────────────────────

describe('GET change requests — the refusal reason reaches only viewers who can read every touched file', () => {
  const FAILURE = {
    reason: 'Waiting on approval for Plugins/x/SKILL.md',
    conflicts: false,
    at: '2026-09-16T10:00:00.000Z',
    byName: 'Ada Admin',
  };
  const CR = {
    number: 7,
    state: 'open',
    touchedNodePaths: ['Plugins/x/SKILL.md', 'Plugins/x/access.md'],
    lastApplyFailure: FAILURE,
  };
  const BO = { id: 'u-bo', email: 'bo@example.com', name: 'Bo' } as AuthUser;

  let server: Server | null = null;
  afterEach(async () => {
    if (server) await closeServer(server);
    server = null;
  });

  async function serve(opts: {
    userId?: string;
    touchedNodePaths?: string[];
    canReadBatch: (paths: string[]) => Promise<Map<string, boolean>>;
  }) {
    const cached = {
      ...CR,
      touchedNodePaths: opts.touchedNodePaths ?? CR.touchedNodePaths,
      lastApplyFailure: { ...FAILURE },
    };
    const workflow = {
      listChangeRequests: vi.fn(async () => [cached]),
      listChangeRequestsAuthoredBy: vi.fn(async () => [cached]),
      listChangeRequestsForUser: vi.fn(async () => [cached]),
      getChangeRequest: vi.fn(async () => cached),
      // A non-empty file list, so the detail route's lazy empty-close stays out of it.
      getChangeRequestDetail: vi.fn(async () => ({ ...cached, files: [{ path: 'Plugins/x/SKILL.md' }] })),
    };
    const canReadBatch = vi.fn(async (_ws: string, _email: string, paths: string[]) => opts.canReadBatch(paths));
    const app = express();
    app.use('/api', (req, _res, next) => {
      if (opts.userId) (req as unknown as { userId: string }).userId = opts.userId;
      next();
    });
    app.use(
      '/api',
      createWorkflowRoutes(
        workflow as unknown as IWorkflowService,
        { getOrCreateForUser: vi.fn(async () => ({ id: 'ws-bo' })) } as unknown as WorkspaceService,
        { getUserById: vi.fn(async () => BO) } as unknown as AuthService,
        { emit: () => {} } as unknown as WorkflowEventBus,
        { canReadBatch } as unknown as IAccessControl,
        'knowledge-base',
      ),
    );
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/workflow/change-requests`;
    return { base, cached, canReadBatch };
  }

  const reasonsFrom = async (base: string) => {
    const read = async (url: string) => (await fetch(url)).json();
    return [
      (await read(base))[0].lastApplyFailure,
      (await read(`${base}/mine`))[0].lastApplyFailure,
      (await read(`${base}/for-me`))[0].lastApplyFailure,
      (await read(`${base}/7`)).lastApplyFailure,
      (await read(`${base}/7/detail`)).lastApplyFailure,
    ];
  };

  it('a viewer who can read every touched file reads the reason on every endpoint', async () => {
    const { base } = await serve({
      userId: BO.id,
      canReadBatch: async (paths) => new Map(paths.map((p) => [p, true])),
    });
    for (const failure of await reasonsFrom(base)) expect(failure).toEqual(FAILURE);
  });

  it("a reader of the folder's access.md but not its content learns the apply failed, not the reason", async () => {
    const { base, cached } = await serve({
      userId: BO.id,
      canReadBatch: async (paths) => new Map(paths.map((p) => [p, p.endsWith('access.md')])),
    });
    for (const failure of await reasonsFrom(base)) {
      expect(failure).toEqual({ ...FAILURE, reason: APPLY_FAILURE_REASON_WITHHELD });
    }
    // The service's (cached) object is never rewritten.
    expect(cached.lastApplyFailure.reason).toBe(FAILURE.reason);
  });

  it('a request with no resolved touched paths withholds the reason — read access is unproven', async () => {
    const { base, canReadBatch } = await serve({
      userId: BO.id,
      touchedNodePaths: [],
      canReadBatch: async (paths) => new Map(paths.map((p) => [p, true])),
    });
    for (const failure of await reasonsFrom(base)) {
      expect(failure.reason).toBe(APPLY_FAILURE_REASON_WITHHELD);
    }
    expect(canReadBatch).not.toHaveBeenCalled();
  });

  it('an access lookup that fails withholds the reason', async () => {
    const { base } = await serve({
      userId: BO.id,
      canReadBatch: async () => {
        throw new Error('access tree unreadable');
      },
    });
    const [failure] = await reasonsFrom(base);
    expect(failure.reason).toBe(APPLY_FAILURE_REASON_WITHHELD);
  });
});

describe('PullRequestService — a recorded or cleared refusal reaches cached list reads too', () => {
  it('invalidating the request evicts the list cache, so the next non-fresh list read sees the new row', async () => {
    let rows: Record<string, unknown>[] = [
      { number: 7, state: 'open', targetBranch: 'main', sourceBranch: 'b', title: 't', body: '',
        authorEmail: 'bo@example.com', authorName: 'Bo', createdAt: new Date(), applyFailureReason: null, applyFailedAt: null },
    ];
    let listReads = 0;
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: async () => {
              listReads++;
              return rows;
            },
          }),
        }),
      }),
    } as unknown as Database;
    const svc = new RealPullRequestService(
      db,
      { findAnyWorkspaceId: async () => 'ws' } as unknown as WorkspaceService,
      {} as unknown as IAccessControl,
      { changedPathsForPr: async () => ['Plugins/x/SKILL.md'] } as unknown as GitService,
    );

    expect((await svc.listOpenPrs())[0]!.lastApplyFailure).toBeNull();
    await svc.listOpenPrs();
    expect(listReads).toBe(1); // cached

    // What recordApplyFailure (and clearing a refusal) does after its write.
    rows = [{ ...rows[0], applyFailureReason: 'gate says no', applyFailedAt: new Date(), applyFailedByName: 'Ada' }];
    svc.invalidateDetailCache(7);

    const [cr] = await svc.listOpenPrs();
    expect(listReads).toBe(2);
    expect(cr!.lastApplyFailure?.reason).toBe('gate says no');
  });
});

// ── Upgrading a database that already holds 0008 refusals ───────────────────

describe('migration 0009 — refusals recorded before the kind existed are classified', () => {
  const migration = readFileSync(
    path.join(coreMigrationsDir(), '0009_change_request_apply_failure_kind.sql'),
    'utf8',
  );

  /**
   * The backfill's CASE, read out of the migration and applied to a 0008 row.
   * Understands exactly the two arm forms it uses (`"col" = true` and
   * `"col" LIKE '…%'`) and throws on any other, so an edit to the migration
   * this cannot follow fails here rather than passing unexamined.
   */
  function backfilledKind(row: Row): string | null {
    const update = migration.slice(migration.indexOf('UPDATE "change_requests"'));
    const where = /WHERE "apply_failed_at" IS NOT NULL AND "apply_failure_kind" IS NULL;/;
    expect(update).toMatch(where);
    if (row.apply_failed_at == null || row.apply_failure_kind != null) return (row.apply_failure_kind as string) ?? null;
    const caseBody = /CASE([\s\S]*?)END/.exec(update)![1]!;
    for (const arm of caseBody.split('\n').map((l) => l.trim()).filter(Boolean)) {
      let m = /^WHEN "(\w+)" = true THEN '(\w+)'$/.exec(arm);
      if (m) {
        if (row[m[1]!] === true) return m[2]!;
        continue;
      }
      m = /^WHEN "(\w+)" LIKE '([^%']*)%' THEN '(\w+)'$/.exec(arm);
      if (m) {
        if (String(row[m[1]!] ?? '').startsWith(m[2]!)) return m[3]!;
        continue;
      }
      m = /^ELSE '(\w+)'$/.exec(arm);
      if (m) return m[1]!;
      throw new Error(`unreadable CASE arm in 0009: ${arm}`);
    }
    return null;
  }

  const legacy = (over: Row): Row => ({
    apply_failed_at: new Date('2026-09-16T10:00:00Z'),
    apply_failure_conflicts: false,
    apply_failure_kind: null,
    ...over,
  });

  it("a gate refusal becomes 'gate', so an approval clears it after the upgrade", () => {
    expect(
      backfilledKind(legacy({ apply_failure_reason: 'Merge gate rejected: Waiting on approval for Plugins/x/SKILL.md' })),
    ).toBe('gate');
  });

  it("a conflict becomes 'conflicts', and anything else 'error'", () => {
    expect(
      backfilledKind(
        legacy({ apply_failure_conflicts: true, apply_failure_reason: 'This draft conflicts with the target and needs resolving first.' }),
      ),
    ).toBe('conflicts');
    expect(backfilledKind(legacy({ apply_failure_reason: 'Merge failed: push rejected' }))).toBe('error');
  });

  it('rows with no refusal, or already classified, are left alone', () => {
    expect(backfilledKind({ apply_failed_at: null, apply_failure_kind: null })).toBeNull();
    expect(backfilledKind(legacy({ apply_failure_kind: 'conflicts', apply_failure_reason: 'Merge gate rejected: x' }))).toBe('conflicts');
  });

  it("the prefix it matches is the one the merge gate's refusal actually carries", () => {
    const gateSource = readFileSync(
      path.join(coreMigrationsDir(), '..', 'src/modules/workflow/review-workflow/review-workflow.service.ts'),
      'utf8',
    );
    const prefix = /LIKE '([^%']*)%' THEN 'gate'/.exec(migration)![1]!;
    expect(gateSource).toContain(`super(\`${prefix} \${reasons.join('; ')`);
  });
});
