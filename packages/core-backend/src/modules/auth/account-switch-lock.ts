import { sql } from 'drizzle-orm';
import type { Database } from '../database/index.js';
import { canonicalEmail } from '../../shared/email-identity.js';
import { VersionControlDomainError } from '../../shared/domain-errors.js';
import { pgErrorCode } from '../database/index.js';

/** The handle `db.transaction` hands its callback. */
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * How long a switch-off or a promotion waits for the address's lock. The
 * holder may be a promotion committing `roles.yaml` (a git commit and push,
 * seconds), so the wait is generous; it is bounded all the same, for the
 * reason `database/advisory-lock.ts` gives: a waiter blocked for good sits
 * on a pooled connection, and a wedged holder would take the pool with it.
 */
export const ACCOUNT_SWITCH_LOCK_WAIT_MS = 15_000;

/** Postgres raises this when `lock_timeout` expires while waiting for a lock. */
const LOCK_NOT_AVAILABLE = '55P03';

/** What a caller is told when the wait ran out: a 409, to try again shortly. */
export const ACCOUNT_BUSY_MESSAGE = 'Another change to this account is still being saved; try again in a moment.';

/**
 * Hold, for the rest of `tx`, the one lock that orders an address's switch-off
 * against a write that must not land on a switched-off account (the invite's
 * Admin promotion).
 *
 * A row lock cannot do it: an address with no account yet has no row, and an
 * account can be created switched off (single sign-on waiting for an admin)
 * or created and switched off while the promotion is being written. So the
 * lock is a transaction-scoped advisory lock on the canonical address, taken
 * by every write that switches an account off and by the promotion, before
 * either reads the row. Whichever comes second waits for the first to commit,
 * then reads what it committed (READ COMMITTED takes a fresh snapshot per
 * statement). A different address that hashes to the same key only waits.
 *
 * The wait is bounded by a transaction-local `lock_timeout`
 * ({@link ACCOUNT_SWITCH_LOCK_WAIT_MS}), which the transaction's end reverts
 * with everything else; running out of it is answered as a 409 `account-busy`.
 */
export async function takeAccountSwitchLock(
  tx: Pick<Tx, 'execute'>,
  email: string,
  waitMs: number = ACCOUNT_SWITCH_LOCK_WAIT_MS,
): Promise<void> {
  await tx.execute(sql`select set_config('lock_timeout', ${String(waitMs)}, true)`);
  try {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`account-switch:${canonicalEmail(email)}`}))`);
  } catch (err) {
    // Drizzle wraps the driver's error, so the SQLSTATE is on its cause.
    if (pgErrorCode(err) === LOCK_NOT_AVAILABLE) {
      throw new VersionControlDomainError(ACCOUNT_BUSY_MESSAGE, 409, { kind: 'account-busy' });
    }
    throw err;
  }
}
