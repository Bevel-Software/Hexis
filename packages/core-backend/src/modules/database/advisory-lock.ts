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
  /** Serializes {@link runCoreMigrations} across processes. */
  CoreMigrations: 1,
  /** Serializes {@link runEnterpriseMigrations} across processes. */
  EnterpriseMigrations: 2,
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
