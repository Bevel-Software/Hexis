import pg from 'pg';
import type { Database } from './connection.js';

/**
 * Postgres advisory locks — the one mechanism by which two Hexis processes
 * agree that only one of them may do a thing at a time.
 *
 * WHY THIS EXISTS. Hexis is single-replica by design (see the notes in
 * `mcp-session-store.ts`, `event-bus.ts` and `pending-commits.worker.ts`), but
 * nothing enforces it, and the deployment topology guarantees an overlap on
 * every redeploy: the reverse-proxy deployments this project targets start the
 * replacement container while the outgoing one is still running — which is
 * exactly why `docker-compose.yml` publishes no fixed host port. For the
 * length of that window two processes share one database and one set of
 * volumes.
 *
 * Drizzle's Postgres migrator takes no lock of its own. It reads the newest
 * applied migration, then opens a transaction and applies everything newer, so
 * two boots read the same watermark and both apply. With an unguarded
 * migration (0002 onward are plain DDL) the second boot fails on an
 * already-applied `ALTER TABLE` and the container crash-loops; with a guarded
 * one it instead writes a second ledger row for the same migration. A lock
 * around the runner removes both outcomes, which is what every migration tool
 * that is not drizzle does.
 *
 * WHY A TRANSACTION RATHER THAN A SESSION LOCK. `pg_advisory_lock` is
 * session-scoped: it belongs to the connection that took it and is released by
 * `pg_advisory_unlock` or by the session ending. Taken through the pool that is
 * a trap — the connection carrying the lock returns to the pool still holding
 * it, and the unlock may run on whichever connection the pool hands out next.
 * `pg_advisory_xact_lock` is held until the transaction ends, so the `rollback`
 * below releases it whatever happened inside, and a connection that dies
 * releases it by dying. The same `rollback` reverts the transaction-local
 * `lock_timeout`, so nothing about this connection is different when it goes
 * back to the pool.
 *
 * The lock is held on its OWN connection while `fn` runs on others. That is
 * deliberate and sufficient: the lock excludes other PROCESSES, and it does not
 * need to be the connection doing the work.
 *
 * WHY IT DOES NOT WAIT FOREVER. A boot blocked indefinitely behind a wedged
 * lock holder is worse than a boot that fails: the container's restart policy
 * is a working retry, and a failed boot is visible. `lock_timeout` bounds the
 * wait and surfaces a named error.
 *
 * The one caveat worth knowing: the lock connection sits idle in a transaction
 * for as long as `fn` runs. A server configured with
 * `idle_in_transaction_session_timeout` shorter than a migration run would kill
 * it and drop the lock. The default is disabled, and migrations here run in
 * seconds.
 */

/**
 * The first argument to every `pg_advisory_*` call below: a namespace shared by
 * every lock this application takes, so that an advisory lock belonging to
 * something else on the same database cannot collide with one of ours by
 * choosing the same number. `HEXI` read as ASCII bytes — stable, inside
 * `int4`, and recognisable in `pg_locks` when someone is working out who holds
 * what.
 */
const LOCK_NAMESPACE = 0x48455849;

/**
 * The locks this application takes, one constant per concern. A new entry is a
 * new claim that two processes must not do something simultaneously, so it
 * belongs here beside the others rather than as a number at a call site.
 */
export const AdvisoryLock = {
  /**
   * Serializes every schema migration across processes — core's and a
   * distribution's alike, under ONE lock: the enterprise migrations reference
   * core's tables, so two boots overlapping with one lock each could still
   * run core's DDL while the other ran enterprise's over it.
   */
  Migrations: 1,
  /**
   * Held by the ONE process allowed to drain the commit queue — see
   * {@link AdvisoryLease}. Row-level `SKIP LOCKED` already stops two workers
   * claiming the same row; it does nothing about two workers running git in
   * the same working tree on a shared volume, which is what this excludes.
   */
  CommitWorker: 3,
} as const;

export type AdvisoryLockId = (typeof AdvisoryLock)[keyof typeof AdvisoryLock];

/** How long to wait for the lock before giving up and failing the boot. */
const DEFAULT_WAIT_MS = 60_000;

/** Postgres raises this when `lock_timeout` expires while waiting for a lock. */
const LOCK_NOT_AVAILABLE = '55P03';

function isLockTimeout(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === LOCK_NOT_AVAILABLE
  );
}

/** The name of a lock, for an error message a human has to act on. */
function lockName(lock: AdvisoryLockId): string {
  const entry = Object.entries(AdvisoryLock).find(([, value]) => value === lock);
  return entry ? entry[0] : String(lock);
}

/**
 * Run `fn` while holding the advisory lock `lock`, waiting up to `waitMs` for
 * it. The lock is released however `fn` ends, and the connection carrying it
 * goes back to the pool in the state it arrived in.
 *
 * Throws without running `fn` when the lock cannot be taken in time — the
 * caller is expected to let that fail the boot.
 */
export async function withAdvisoryLock<T>(
  db: Database,
  lock: AdvisoryLockId,
  fn: () => Promise<T>,
  opts: { waitMs?: number } = {},
): Promise<T> {
  const waitMs = opts.waitMs ?? DEFAULT_WAIT_MS;
  const client = await db.$client.connect();
  try {
    await client.query('begin');
    try {
      // `set_config` rather than `SET LOCAL`, which cannot take a bind
      // parameter. `true` makes the setting transaction-local, so the
      // `rollback` below reverts it.
      await client.query("select set_config('lock_timeout', $1, true)", [String(waitMs)]);
      await client.query('select pg_advisory_xact_lock($1, $2)', [LOCK_NAMESPACE, lock]);
    } catch (err) {
      if (isLockTimeout(err)) {
        throw new Error(
          `Timed out after ${waitMs}ms waiting for the ${lockName(lock)} advisory lock. ` +
            'Another process is holding it — usually the outgoing container of a redeploy, ' +
            'in which case starting again succeeds once it exits.',
          { cause: err },
        );
      }
      throw err;
    }
    return await fn();
  } finally {
    // Ends the transaction, which releases the lock and reverts `lock_timeout`.
    // A connection that cannot be rolled back is destroyed rather than returned
    // to the pool: ending its session is what releases the lock, and a
    // connection in an unknown transaction state is no use to anyone else.
    let rollbackError: Error | undefined;
    try {
      await client.query('rollback');
    } catch (err) {
      rollbackError = err instanceof Error ? err : new Error(String(err));
    }
    client.release(rollbackError);
  }
}

/** The slice of a `pg.Client` the lease uses — so a suite can hand in a double. */
export interface LeaseClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  end(): Promise<void>;
  on(event: 'error' | 'end', listener: (...args: unknown[]) => void): unknown;
}

export interface AdvisoryLeaseOptions {
  /** How the lease opens its connection. Default: a `pg.Client` on the pool's connection string. */
  connect?: () => Promise<LeaseClient>;
  /** Bound on the connect and on each query, so an unreachable or half-dead database fails rather than waits. Default 10s. */
  connectTimeoutMs?: number;
}

/**
 * A SESSION-scoped advisory lock held for as long as this process wants it:
 * the singleton lease. `tryAcquire` never waits — it answers whether this
 * process is the holder — and the lock lives on a connection of its own for
 * the process's lifetime, released by {@link release} or by that connection
 * ending, however it ends.
 *
 * WHY ITS OWN CONNECTION, AND WHY THAT IS FINE. A session lock belongs to the
 * connection that took it, so it cannot ride the pool (see the transaction
 * form above for what goes wrong when it does). This connection is therefore
 * opened once and kept, which is the one shape of resource the closing-owner
 * rule exempts when it is said out loud: its lifetime is intentionally the
 * process's. The owner that closes it is the shutdown sequence, through
 * `release`, and if the process dies without one the session dies with it
 * and Postgres releases the lock — which is exactly how the NEXT process gets
 * to take it.
 *
 * LOSS IS A FIRST-CLASS EVENT. A connection can drop (a database restart, a
 * network blip) while this process believes it holds the lease; from that
 * moment another process may hold it too. So the lease watches its connection
 * and tells its listeners the instant the holding session is gone, and
 * `held` flips false before any of them run — a holder that keeps working
 * after that call is the double-worker case this exists to prevent.
 */
export class AdvisoryLease {
  private client: LeaseClient | null = null;
  private heldFlag = false;
  private readonly lostListeners: Array<() => void> = [];

  constructor(
    private readonly db: Database,
    private readonly lock: AdvisoryLockId,
    private readonly opts: AdvisoryLeaseOptions = {},
  ) {}

  /** Whether this process holds the lease right now. */
  get held(): boolean {
    return this.heldFlag;
  }

  /** Called when the holding connection ends without {@link release} — the lease is gone. */
  onLost(listener: () => void): void {
    this.lostListeners.push(listener);
  }

  /**
   * Take the lease if nobody holds it. Returns at once either way: `true` and
   * this process is the holder from now on; `false` and nothing is held or
   * kept open.
   */
  async tryAcquire(): Promise<boolean> {
    if (this.heldFlag) return true;
    const client = await (this.opts.connect ?? this.defaultConnect)();
    // Watched BEFORE the lock is asked for — a `pg.Client` throws an 'error'
    // with no listener at the process — and bound to THIS client: a loss is
    // only a loss while this is the connection the lease is held on. Before
    // the grant below the client is not that connection, so a drop during
    // the query surfaces as the query's own rejection and nothing is marked
    // held; after a release or a later reacquisition it is not that
    // connection either, so a stale client's delayed 'end' cannot clear a
    // lease held on a healthy one.
    const lost = () => {
      if (this.client === client) this.markLost();
    };
    client.on('error', lost);
    client.on('end', lost);
    try {
      const { rows } = await client.query('select pg_try_advisory_lock($1, $2) as held', [
        LOCK_NAMESPACE,
        this.lock,
      ]);
      if (rows[0]?.held !== true) {
        await client.end().catch(() => undefined);
        return false;
      }
      this.client = client;
      this.heldFlag = true;
      return true;
    } catch (err) {
      await client.end().catch(() => undefined);
      throw err;
    }
  }

  /**
   * Give the lease up and close its connection. Idempotent, and safe to call
   * on a lease that was never taken or has already been lost.
   */
  async release(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.heldFlag = false;
    if (!client) return;
    try {
      await client.query('select pg_advisory_unlock($1, $2)', [LOCK_NAMESPACE, this.lock]);
    } catch {
      // Ending the session below releases the lock regardless.
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  private markLost(): void {
    if (!this.heldFlag) return;
    this.heldFlag = false;
    this.client = null;
    for (const listener of this.lostListeners) listener();
  }

  private readonly defaultConnect = async (): Promise<LeaseClient> => {
    const timeout = this.opts.connectTimeoutMs ?? 10_000;
    const client = new pg.Client({
      connectionString: this.db.$client.options.connectionString,
      connectionTimeoutMillis: timeout,
      // The same bound on each query: a connection that opened and then went
      // half-dead would otherwise hold `tryAcquire` open indefinitely, and
      // with it the loop that should be asking again in five seconds.
      query_timeout: timeout,
    });
    await client.connect();
    return client;
  };
}
