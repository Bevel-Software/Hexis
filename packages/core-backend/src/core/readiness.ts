import { sql } from 'drizzle-orm';
import type { Database } from '../modules/database/connection.js';

/**
 * The readiness answer: what `GET /api/ready` reports, computed when asked.
 *
 * `/api/health` says the process is up, and that is all it has ever said —
 * it answers `ok` whenever Express does. Nothing about the deployment told
 * anyone when it had stopped committing: a queue that no longer drains looks
 * exactly like an idle one from outside, and the one signal the worker
 * raises for a terminal failure goes to stderr in a core deployment. This
 * endpoint exists so that a deployment can say it has degraded, and so that
 * one number — the age of the oldest commit still waiting — can be alerted on.
 *
 * EVERY FACT IS COMPUTED ON THE REQUEST. None is stored, because a stored
 * verdict is stale the moment its inputs change and brings invalidation and
 * retention along with it for nothing: each of these is a cheap read, and the
 * probe is the one place that asks.
 *
 * WHAT DEGRADES AND WHAT FAILS. Only an unreachable database fails the
 * probe with a 503: without it nothing here can serve. Everything else marks
 * the answer `degraded` and stays 200. This is deliberate. An orchestrator
 * treats a failing readiness probe as "restart me", and a restart cures none
 * of the other conditions — a git host that has stopped answering, a full
 * volume, a queue that has fallen behind — while it does throw away every
 * in-flight request and the replay buffer. Those are conditions to page on,
 * not to restart for; the numbers are in the body for exactly that.
 *
 * WHAT IS DISCLOSED. The probe is unauthenticated, as a probe must be for the
 * thing that calls it, so it discloses only what an operator needs and nothing
 * that names a person, a path or a workspace: booleans, ages and byte counts.
 * The build sha is already public on `/api/health`.
 */

export interface ReadinessDeps {
  db: Pick<Database, 'execute'>;
  /** When the oldest commit still waiting was queued, or null when none waits. */
  oldestQueuedAt(): Promise<Date | null>;
  /** Whether THIS process holds the commit-worker lease and is draining. */
  drains(): boolean;
  /** The most recent attempt to reach the git remote, and whether it succeeded. */
  lastRemoteContact(): { at: number; ok: boolean } | null;
  /** Bytes still writable on the volume holding the workspaces. */
  freeBytes(): Promise<number | null>;
  now?: () => number;
}

export interface ReadinessReport {
  status: 'ok' | 'degraded' | 'unavailable';
  checks: {
    database: { ok: boolean };
    /** Age in seconds of the oldest waiting commit; null when nothing waits. */
    commitQueue: { ok: boolean; oldestPendingSeconds: number | null; draining: boolean };
    /** Seconds since the last attempt to reach the remote; null before the first. */
    gitRemote: { ok: boolean; lastContactSeconds: number | null };
    disk: { ok: boolean; freeBytes: number | null };
  };
  timestamp: number;
}

/**
 * A commit older than this is one the deployment should be paged about: at a
 * healthy pace a save lands in seconds, and a backlog of minutes means either
 * the worker is not draining or its remote is refusing it. Ten minutes leaves
 * room for a large bulk change and a slow push without crying wolf.
 */
export const QUEUE_AGE_DEGRADED_MS = 10 * 60 * 1000;

/**
 * Below this much free space the next clone or pack write is a coin toss.
 * One gibibyte is more than any single operation here needs and well under
 * any volume a deployment would provision, so crossing it is a warning with
 * time left to act.
 */
export const DISK_FREE_DEGRADED_BYTES = 1024 * 1024 * 1024;

export function createReadiness(deps: ReadinessDeps): () => Promise<ReadinessReport> {
  const now = deps.now ?? Date.now;

  return async () => {
    const at = now();

    const database = await deps.db
      .execute(sql`select 1`)
      .then(() => ({ ok: true }))
      .catch(() => ({ ok: false }));

    // Each fact is asked for independently and a failure to answer counts
    // against that fact alone, never against the others.
    const oldest = await deps.oldestQueuedAt().catch(() => null);
    const oldestPendingSeconds = oldest === null ? null : Math.max(0, Math.floor((at - oldest.getTime()) / 1000));
    const commitQueue = {
      ok: oldestPendingSeconds === null || oldestPendingSeconds * 1000 < QUEUE_AGE_DEGRADED_MS,
      oldestPendingSeconds,
      draining: deps.drains(),
    };

    const contact = deps.lastRemoteContact();
    const gitRemote = {
      // No attempt yet is not a failure: a freshly booted process has had no
      // reason to reach the remote, and saying "degraded" for that would
      // page on every deploy.
      ok: contact === null || contact.ok,
      lastContactSeconds: contact === null ? null : Math.max(0, Math.floor((at - contact.at) / 1000)),
    };

    const free = await deps.freeBytes().catch(() => null);
    const disk = {
      // A volume that cannot say is not known to be full; the number is null
      // and the fact stays ok rather than paging on an unanswerable probe.
      ok: free === null || free >= DISK_FREE_DEGRADED_BYTES,
      freeBytes: free,
    };

    const status: ReadinessReport['status'] = !database.ok
      ? 'unavailable'
      : commitQueue.ok && gitRemote.ok && disk.ok
        ? 'ok'
        : 'degraded';

    return { status, checks: { database, commitQueue, gitRemote, disk }, timestamp: at };
  };
}
