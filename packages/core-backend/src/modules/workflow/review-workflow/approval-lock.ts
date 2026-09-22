import { sql } from 'drizzle-orm';
import type { Database } from '../../database/connection.js';

/**
 * The lock every writer of `pr_file_approvals` takes, and the one thing that
 * orders them against each other.
 *
 * Three writers exist, in two different modules: a change request bringing
 * itself up to date copies the approvals its merge did not disturb onto the
 * new head, a reviewer approves or revokes one file, and account erasure
 * rewrites an erased person's name and address out of every row they ever
 * approved. Any two of those interleaved lose something real — a revoke that
 * comes back, an approval pinned to a head that has already gone, or an erased
 * address re-inserted onto a new head by a copy that read it a moment before
 * the erasure landed.
 *
 * In the DATABASE, not in this process: two app instances share the rows but
 * not a mutex. Advisory locks share one namespace across the whole database,
 * so everything here is keyed by (this class, a key) and can never collide
 * with another subsystem's.
 */
const APPROVAL_LOCK_CLASS = 4207;
/**
 * The key that means EVERY change request. Change request numbers start at 1,
 * so nothing else claims it.
 *
 * Held shared by the per-request writers — they do not exclude each other, the
 * per-request key does that — and exclusively by the one writer whose reach is
 * every request at once. That is what makes "all approvals of this person" a
 * single serialized step rather than a race against whichever copy happens to
 * be in flight.
 */
const EVERY_REQUEST = 0;
/**
 * How long a per-request approval write waits before giving up.
 *
 * Every body under this lock is a statement or two against rows already in
 * cache, so a wait anywhere near this is a stuck holder rather than a busy
 * one — and waiting a stuck holder out would pin a pooled connection for as
 * long as it lasts, which is how one wedged transaction becomes a backend with
 * no connections left. Five seconds is far past honest contention and far
 * short of that.
 */
export const APPROVAL_LOCK_TIMEOUT_MS = 5_000;
/**
 * The same, for erasure — longer, because erasure must not fail over ordinary
 * contention. It waits out every per-request writer in flight (each of them
 * sub-second, and bounded by the timeout above), and gives up only on a holder
 * that has genuinely wedged. Its transaction is atomic, so giving up erases
 * nothing and the operator simply runs it again.
 */
export const ERASURE_LOCK_TIMEOUT_MS = 30_000;
/** `lock_timeout` fired — Postgres `lock_not_available`. */
const LOCK_NOT_AVAILABLE = '55P03';

/** The handle `db.transaction` hands its callback — a `Database` minus the pool. */
export type ApprovalTx = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Whether a rejection is that timeout. The driver surfaces the SQLSTATE on the
 * error itself today; `cause` is checked too so a driver that starts wrapping
 * its errors does not turn a retryable refusal back into a bare 500.
 */
export function isApprovalLockTimeout(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 3; e = (e as { cause?: unknown }).cause, depth++) {
    if ((e as { code?: unknown }).code === LOCK_NOT_AVAILABLE) return true;
  }
  return false;
}

/**
 * Claim one change request's approvals for the rest of `tx`.
 *
 * Shared on the every-request key first, then exclusive on this request's:
 * writers of different requests run side by side, writers of the same one
 * queue, and an erasure waits for all of them before it starts. The order is
 * the same in both directions of this file, which is what keeps the pair
 * deadlock-free.
 *
 * Call it as the first thing in the transaction, before any row is read: each
 * statement in a READ COMMITTED transaction takes a fresh snapshot, so a
 * select made after the lock sees everything the previous holder committed,
 * while one made before it sees a world that may already be gone.
 */
export async function takeApprovalLock(tx: ApprovalTx, prNumber: number): Promise<void> {
  // SET takes no bind parameters, so the interval is rendered from a module
  // constant — never from anything a caller supplies.
  await tx.execute(sql.raw(`set local lock_timeout = ${APPROVAL_LOCK_TIMEOUT_MS}`));
  await tx.execute(sql`select pg_advisory_xact_lock_shared(${APPROVAL_LOCK_CLASS}, ${EVERY_REQUEST})`);
  await tx.execute(sql`select pg_advisory_xact_lock(${APPROVAL_LOCK_CLASS}, ${prNumber})`);
}

/**
 * Claim the approvals of EVERY change request for the rest of `tx` — account
 * erasure, whose rewrite is keyed by a person rather than by a request.
 *
 * Exclusive on the every-request key: it waits for every per-request writer in
 * flight and holds the rest off until the erasure commits. Without it, a
 * carry-forward that read an approval a moment earlier would re-insert the
 * erased address onto the new head, after the statement that was supposed to
 * be the last trace of it.
 *
 * Take it BEFORE the statement that anonymizes the rows, not at the top of the
 * transaction: what it has to cover is that rewrite and everything after it,
 * and starting later is that many fewer milliseconds of approvals queueing
 * behind an erasure.
 */
export async function takeEveryApprovalLock(tx: ApprovalTx): Promise<void> {
  await tx.execute(sql.raw(`set local lock_timeout = ${ERASURE_LOCK_TIMEOUT_MS}`));
  await tx.execute(sql`select pg_advisory_xact_lock(${APPROVAL_LOCK_CLASS}, ${EVERY_REQUEST})`);
}
