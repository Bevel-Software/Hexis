import { sql } from 'drizzle-orm';
import type { Database } from '../database/connection.js';
import { canonicalEmail } from '../../shared/email-identity.js';

/** The handle `db.transaction` hands its callback. */
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

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
 */
export async function takeAccountSwitchLock(tx: Pick<Tx, 'execute'>, email: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`account-switch:${canonicalEmail(email)}`}))`);
}
