/**
 * Persistent queue of "files written to disk but not yet committed to git."
 *
 * Decouples the lock-release path from git work: `WorkflowService.releaseLock`
 * enqueues a row and returns immediately; the background `PendingCommitsWorker`
 * drains rows by running `commitFile + push`. Persistence is the point — a
 * process crash mid-commit (the bug class that stranded the `GTM/Uploads/*.docx`
 * files) leaves resumable work for the next worker pass instead of an orphan
 * on disk that nobody will ever commit.
 *
 * See `lock-decoupling-plan.md` for the full design context.
 *
 * Lifecycle of a row:
 *
 *     enqueue ──> status='pending'
 *           │
 *     claimNext (atomic UPDATE) ──> status='running'
 *           │
 *     ┌─────┴─────────────────────────────┐
 *     │ commit + push succeeds            │ commit/push throws
 *     ▼                                   ▼
 *     markSucceeded                       attempts++
 *     (row deleted)              ┌────────┴────────────────┐
 *                                │ attempts < N_TRANSIENT  │ attempts ≥ N_TRANSIENT
 *                                ▼                          ▼
 *                                markTransientFailure       markRecoveryStarted
 *                                (status='pending';          (recoveryAgentRuns++;
 *                                 backoff via                 attempts=0;
 *                                 last_attempted_at)          status='pending')
 *                                                              │
 *                                                              ▼
 *                                                  if recoveryAgentRuns ≥ N_RECOVERY:
 *                                                    markNeedsAttention
 *                                                    (status='needs_attention')
 */

import { and, eq, isNull, or, sql } from 'drizzle-orm';
import type { Database } from '../database/connection.js';
import { pendingCommits } from '../database/schema.js';

/**
 * Transient-failure budget per recovery cycle. After this many consecutive
 * `commit + push` failures we hand off to the recovery agent (which gets its
 * own budget of N_RECOVERY runs before we escalate). 3 covers a normal
 * teammate-pushed-while-we-were-pushing race plus a backoff retry, while
 * keeping recovery latency bounded for genuinely stuck rows.
 */
export const N_TRANSIENT = 3;

/**
 * How many full recovery-agent runs we kick off before declaring a row
 * unrecoverable and emitting a `'system'` feedback notice. Each run gets a
 * fresh transient budget, so the real ceiling is `N_TRANSIENT × N_RECOVERY`
 * commit attempts per row.
 */
export const N_RECOVERY = 3;

/**
 * Exponential backoff between transient retries, indexed by the current
 * `pending_commits.attempts` value. `claimNext` reads `BACKOFF_MS[attempts]`
 * straight off the row, so:
 *
 *   - `attempts === 0` (fresh enqueue, never tried) is gated by
 *     `BACKOFF_MS[0]` only when `last_attempted_at` is already set — the
 *     usual first-sight case has `last_attempted_at IS NULL` and skips
 *     backoff entirely. The `attempts === 0` arm matters for
 *     recovery-reset rows (see `markRecoveryStarted`), which leave
 *     `last_attempted_at` populated.
 *   - After `markTransientFailure` bumps `attempts` to `1`, the next
 *     retry waits `BACKOFF_MS[1]` (5s).
 *   - And so on, up to `attempts === N_TRANSIENT - 1`, after which the
 *     row leaves the transient-retry phase entirely.
 *
 * Length therefore needs `>= N_TRANSIENT` so every value of `attempts` in
 * `[0, N_TRANSIENT)` has a defined backoff entry.
 */
export const BACKOFF_MS = [1_000, 5_000, 30_000];

/**
 * Canonicalize a workspace id so an enqueued row and the worker's claim always
 * key on the SAME string.
 *
 * The id reaches `enqueue` via a route `:id` path param, which Express
 * URL-decodes — so a slashed feature branch arrives as `alice/feature`. But the
 * worker claims per `WorkspaceService.knownWorkspaces()`, whose ids are
 * `encodeURIComponent(branch)` → `alice%2Ffeature`. Those strings differ, so
 * `WHERE workspace_id = …` never matched and the row was never drained —
 * silently stranding every human save on a feature branch (protected branches
 * have no `/`, so encoded == decoded and they were unaffected).
 *
 * `encodeURIComponent(decodeURIComponent(id))` is idempotent and collapses both
 * forms to the encoded id `knownWorkspaces()` uses. A malformed `%` sequence
 * (which `decodeURIComponent` would throw on) is left untouched.
 */
export function canonicalWorkspaceId(id: string): string {
  try {
    return encodeURIComponent(decodeURIComponent(id));
  } catch {
    return id;
  }
}

export interface PendingCommit {
  id: string;
  workspaceId: string;
  branch: string;
  path: string;
  authorEmail: string;
  authorName: string;
  queuedAt: Date;
  status: 'pending' | 'running' | 'needs_attention';
  attempts: number;
  recoveryAgentRuns: number;
  lastAttemptedAt: Date | null;
  lastError: string | null;
}

export interface EnqueueInput {
  workspaceId: string;
  branch: string;
  path: string;
  authorEmail: string;
  authorName: string;
}

export interface WorkspaceDescriptor {
  id: string;
  branch: string;
}

type Row = typeof pendingCommits.$inferSelect;

function rowToPending(row: Row): PendingCommit {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    branch: row.branch,
    path: row.path,
    authorEmail: row.authorEmail,
    authorName: row.authorName,
    queuedAt: row.queuedAt,
    status: row.status as PendingCommit['status'],
    attempts: row.attempts,
    recoveryAgentRuns: row.recoveryAgentRuns,
    lastAttemptedAt: row.lastAttemptedAt,
    lastError: row.lastError,
  };
}

/**
 * Caller for `startupReconcile` — yields paths the working tree currently
 * has dirty but `pending_commits` doesn't know about (orphans from a prior
 * process crash). Injected rather than baked in so this service stays
 * database-only and the WorkspaceService keeps owning the on-disk walk.
 */
export interface OrphanScanner {
  scan(workspace: WorkspaceDescriptor): Promise<
    Array<{ path: string }>
  >;
}

export class PendingCommitsService {
  constructor(private readonly db: Database) {}

  /**
   * Enqueue a path for the worker to commit. De-duplicates on
   * `(workspaceId, branch, path)`: a second save of the same file while a
   * prior row is still pending bumps `queued_at` so the latest save's bytes
   * win when the row is eventually claimed (commitFile commits whatever's
   * on disk, not "the version that triggered this row"). A row that's
   * `running` or `needs_attention` is left alone — both states represent
   * in-flight or terminal work the caller shouldn't disturb.
   */
  async enqueue(input: EnqueueInput): Promise<void> {
    const email = input.authorEmail.trim().toLowerCase();
    // Store the canonical (encoded) workspace id so the worker's per-workspace
    // claim — which keys on `knownWorkspaces()`'s encoded ids — can find this row
    // even when the enqueuing route delivered a URL-decoded id.
    const workspaceId = canonicalWorkspaceId(input.workspaceId);
    // Try to refresh an existing pending row for this path first. If nothing
    // matches, fall through to an INSERT. The `releaseLock` call path serialises
    // these two statements under the per-workspace mutex (`mutex.run(workspaceId,
    // ...)`), so user-driven saves can't interleave here. `startupReconcile`
    // bypasses the mutex (it enqueues orphans found on disk at boot), but the
    // schema explicitly allows duplicate `(workspaceId, branch, path)` rows
    // (see `database/schema.ts` near the `pendingCommits` definition), so a
    // racing INSERT just produces a second row the worker will collapse on its
    // next idempotent commit pass — no constraint violation, no double-commit.
    const updated = await this.db
      .update(pendingCommits)
      .set({
        queuedAt: new Date(),
        authorEmail: email,
        authorName: input.authorName,
        // Reset transient counters — this is effectively a fresh enqueue.
        attempts: 0,
        lastError: null,
        lastAttemptedAt: null,
      })
      .where(
        and(
          eq(pendingCommits.workspaceId, workspaceId),
          eq(pendingCommits.branch, input.branch),
          eq(pendingCommits.path, input.path),
          eq(pendingCommits.status, 'pending'),
        ),
      )
      .returning({ id: pendingCommits.id });
    if (updated.length > 0) return;
    await this.db.insert(pendingCommits).values({
      workspaceId,
      branch: input.branch,
      path: input.path,
      authorEmail: email,
      authorName: input.authorName,
    });
  }

  /**
   * Enqueue ONLY when no row — in ANY status — exists for
   * `(workspaceId, branch, path)`. The pull-conflict recovery dispatch uses
   * this instead of `enqueue` because that path can fire repeatedly (every
   * branch focus / merge retries the pull) and `enqueue`'s refresh
   * semantics would reset the existing row's retry counters each time —
   * starving the worker's ladder so the recovery agent never spawns. A
   * `needs_attention` row also blocks re-entry on purpose: the ladder
   * already escalated that divergence to a human; spawning more agents on
   * it would loop.
   *
   * Returns whether a row was inserted. Race window between the existence
   * check and the insert is harmless — the schema allows duplicate rows and
   * the worker's idempotent commit pass collapses them (same reasoning as
   * `startupReconcile`'s bypass of the mutex).
   */
  async enqueueIfAbsent(input: EnqueueInput): Promise<boolean> {
    const workspaceId = canonicalWorkspaceId(input.workspaceId);
    const rows = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(pendingCommits)
      .where(
        and(
          eq(pendingCommits.workspaceId, workspaceId),
          eq(pendingCommits.branch, input.branch),
          eq(pendingCommits.path, input.path),
        ),
      );
    if ((rows[0]?.count ?? 0) > 0) return false;
    await this.db.insert(pendingCommits).values({
      workspaceId,
      branch: input.branch,
      path: input.path,
      authorEmail: input.authorEmail.trim().toLowerCase(),
      authorName: input.authorName,
    });
    return true;
  }

  /**
   * Atomically claim the next ready row for `workspaceId`. "Ready" means:
   *
   *   - `status = 'pending'`, AND
   *   - either `last_attempted_at IS NULL` (never tried yet) OR
   *     `last_attempted_at + backoff(attempts) <= now()` (backoff elapsed).
   *     `backoff(attempts)` (not `attempts - 1`) is intentional: it covers
   *     the recovery-reset case where `attempts` is `0` but
   *     `last_attempted_at` is non-null, otherwise the row would fall into
   *     the default arm and idle for the max backoff after each recovery.
   *
   * Uses `FOR UPDATE SKIP LOCKED` inside a sub-select so two worker passes
   * (in case a future deploy ever runs multiple processes) can't double-claim
   * the same row. The outer UPDATE flips `status` to `'running'` and bumps
   * `last_attempted_at` to fence subsequent loops.
   *
   * Returns the claimed row, or `null` if nothing is ready.
   */
  async claimNext(rawWorkspaceId: string, now: Date): Promise<PendingCommit | null> {
    // Match the canonical form `enqueue` stores (see `canonicalWorkspaceId`).
    const workspaceId = canonicalWorkspaceId(rawWorkspaceId);
    // Backoff schedule as a SQL CASE so the gate runs server-side instead
    // of round-tripping the row to compute eligibility. Index in BACKOFF_MS
    // matches `attempts` directly — covers `attempts == 0` (a recovery-reset
    // row whose `lastAttemptedAt` is non-null; without this, it would fall
    // into ELSE = max backoff and be stuck waiting 30s after every recovery).
    const caseArms = BACKOFF_MS.map((ms, i) => sql`WHEN ${i} THEN ${ms}`);
    const lastMs = BACKOFF_MS[BACKOFF_MS.length - 1];
    const backoffMsExpr = sql`(CASE ${pendingCommits.attempts} ${sql.join(caseArms, sql` `)} ELSE ${lastMs} END)`;
    const readyExpr = or(
      isNull(pendingCommits.lastAttemptedAt),
      sql`${pendingCommits.lastAttemptedAt} + (${backoffMsExpr} || ' milliseconds')::interval <= ${now}`,
    );
    const claimed = await this.db
      .update(pendingCommits)
      .set({ status: 'running', lastAttemptedAt: now })
      .where(
        sql`${pendingCommits.id} = (
          SELECT ${pendingCommits.id} FROM ${pendingCommits}
          WHERE ${pendingCommits.workspaceId} = ${workspaceId}
            AND ${pendingCommits.status} = 'pending'
            AND ${readyExpr}
          ORDER BY ${pendingCommits.queuedAt} ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )`,
      )
      .returning();
    return claimed.length > 0 ? rowToPending(claimed[0]) : null;
  }

  /**
   * Commit + push landed. Drop the row.
   */
  async markSucceeded(id: string): Promise<void> {
    await this.db.delete(pendingCommits).where(eq(pendingCommits.id, id));
  }

  /**
   * Transient failure. Bump `attempts`, store the error, flip back to
   * `'pending'` so the next worker pass can re-claim once backoff elapses.
   * Caller (worker) only invokes this when `attempts + 1 < N_TRANSIENT`.
   */
  async markTransientFailure(id: string, error: string): Promise<void> {
    await this.db
      .update(pendingCommits)
      .set({
        status: 'pending',
        attempts: sql`${pendingCommits.attempts} + 1`,
        lastError: error,
        lastAttemptedAt: new Date(),
      })
      .where(eq(pendingCommits.id, id));
  }

  /**
   * About to spawn a recovery agent. Bump `recovery_agent_runs`, reset
   * `attempts` to 0 so the post-recovery commits get a fresh transient
   * budget, flip back to `'pending'` so the next worker pass picks the
   * row up again (post-recovery the underlying error is usually fixed).
   */
  async markRecoveryStarted(id: string): Promise<void> {
    await this.db
      .update(pendingCommits)
      .set({
        status: 'pending',
        attempts: 0,
        recoveryAgentRuns: sql`${pendingCommits.recoveryAgentRuns} + 1`,
        lastAttemptedAt: new Date(),
      })
      .where(eq(pendingCommits.id, id));
  }

  /**
   * Terminal failure. Row stays in `needs_attention` forever (until an
   * admin deletes or repairs it). The worker emits a `'system'` feedback
   * notice in the same pass — that lives in the worker, not here, so the
   * service stays storage-only.
   */
  async markNeedsAttention(id: string, error: string): Promise<void> {
    await this.db
      .update(pendingCommits)
      .set({
        status: 'needs_attention',
        lastError: error,
        lastAttemptedAt: new Date(),
      })
      .where(eq(pendingCommits.id, id));
  }

  /**
   * Admin / dashboard surface. Returns everything stuck in
   * `needs_attention` for triage.
   */
  async listNeedsAttention(): Promise<PendingCommit[]> {
    const rows = await this.db
      .select()
      .from(pendingCommits)
      .where(eq(pendingCommits.status, 'needs_attention'));
    return rows.map(rowToPending);
  }

  /**
   * Test / admin helper — how many `pending` rows for this workspace?
   * `running` and `needs_attention` are excluded; both represent work the
   * worker is NOT going to pick up on its next sweep.
   */
  async countPending(rawWorkspaceId: string): Promise<number> {
    const workspaceId = canonicalWorkspaceId(rawWorkspaceId);
    const rows = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(pendingCommits)
      .where(
        and(
          eq(pendingCommits.workspaceId, workspaceId),
          eq(pendingCommits.status, 'pending'),
        ),
      );
    return rows[0]?.count ?? 0;
  }

  /**
   * Is there ANY row (regardless of status) for this workspace? Used by the
   * git status path to tell an EXPECTED dirty working tree (files saved to
   * disk whose commits are still queued/running/stuck) apart from a genuinely
   * orphaned one — only the latter deserves the loud "missed lock-release
   * commit" warning.
   */
  async hasAnyForWorkspace(rawWorkspaceId: string): Promise<boolean> {
    const workspaceId = canonicalWorkspaceId(rawWorkspaceId);
    const rows = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(pendingCommits)
      .where(eq(pendingCommits.workspaceId, workspaceId));
    return (rows[0]?.count ?? 0) > 0;
  }

  /**
   * Process startup recovery. Two jobs:
   *
   *   1. Reset any `status='running'` rows back to `'pending'`. The
   *      previous process crashed mid-commit; the new worker should pick
   *      these up just like any other pending row.
   *   2. For each known workspace, walk the working tree (via the injected
   *      scanner) and enqueue any dirty path that isn't already
   *      represented in the queue. This is what cleans up disk-only
   *      orphans left by past pre-queue crashes (the existing
   *      `GTM/Uploads/*.docx` strays on `target-company-state`).
   *
   * `systemAuthor` is the synthetic recovery-bot identity sweep-enqueued
   * rows are attributed to — the original author isn't recoverable
   * post-hoc.
   */
  async startupReconcile(
    workspaces: Iterable<WorkspaceDescriptor>,
    scanner: OrphanScanner,
    systemAuthor: { email: string; name: string },
  ): Promise<void> {
    // One-time backfill: rows enqueued before `canonicalWorkspaceId` landed may
    // hold a URL-decoded workspace_id that `claimNext` (which keys on the encoded
    // `knownWorkspaces()` id) never matched — so they'd sit forever unclaimed.
    // Rewrite any non-canonical id to its canonical form so those rows drain.
    // (Two decoded/encoded variants collapsing to one id just yields duplicate
    // rows, which the worker's idempotent commit pass harmlessly no-ops.)
    const distinctIds = await this.db
      .selectDistinct({ workspaceId: pendingCommits.workspaceId })
      .from(pendingCommits);
    for (const { workspaceId } of distinctIds) {
      const canonical = canonicalWorkspaceId(workspaceId);
      if (canonical !== workspaceId) {
        await this.db
          .update(pendingCommits)
          .set({ workspaceId: canonical })
          .where(eq(pendingCommits.workspaceId, workspaceId));
      }
    }

    await this.db
      .update(pendingCommits)
      .set({ status: 'pending', lastAttemptedAt: new Date() })
      .where(eq(pendingCommits.status, 'running'));

    for (const workspace of workspaces) {
      let dirty: Array<{ path: string }>;
      try {
        dirty = await scanner.scan(workspace);
      } catch (err) {
        console.warn(
          `[pending-commits] startup scan failed for workspace=${workspace.id}:`,
          err instanceof Error ? err.message : err,
        );
        continue;
      }
      for (const entry of dirty) {
        await this.enqueue({
          workspaceId: workspace.id,
          branch: workspace.branch,
          path: entry.path,
          authorEmail: systemAuthor.email,
          authorName: systemAuthor.name,
        });
      }
    }
  }
}

