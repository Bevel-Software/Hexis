import { eq } from 'drizzle-orm';
import type { AuthUser } from '@bevel-software/platform-shared';
import { users, type Database } from '../database/index.js';
import { canonicalEmail } from '../../shared/email-identity.js';
import { VersionControlDomainError } from '../../shared/domain-errors.js';
import { takeRecordWriterLock } from './change-request-review/approval-lock.js';

/*
 * How version control records the person behind a BOT's change: in a
 * commit's trailer, and in the rows of this module that keep a change's
 * author (a pending commit, an approval, a change request's history). Owned
 * here because those records are this module's.
 */

/**
 * The columns that record the person behind a BOT's action (`modules/bots`)
 * beside its author: the person who made the connection the bot acts
 * through. All null for a person's own action. ONE spelling, so every table
 * of this module that keeps an author keeps the person behind a bot the same way.
 */
export function madeByColumns(madeBy: { name: string; email: string } | undefined): {
  madeByEmail: string | null;
  madeByEmailBidx: string | null;
  madeByName: string | null;
} {
  if (!madeBy) return { madeByEmail: null, madeByEmailBidx: null, madeByName: null };
  const email = canonicalEmail(madeBy.email);
  return { madeByEmail: email, madeByEmailBidx: email, madeByName: madeBy.name };
}

/** The git trailer a bot's commit carries, naming the person behind it; null for a person's own commit. */
export function madeByTrailer(madeBy: { name: string; email: string } | undefined): string | null {
  if (!madeBy) return null;
  // The same characters git's author parsing cannot take are dropped here.
  const clean = (s: string) => s.replace(/[\r\n<>]/g, '').trim();
  return `Made-by: ${clean(madeBy.name)} <${clean(canonicalEmail(madeBy.email))}>`;
}

/** A transaction handle, as `Database.transaction` hands it to its callback. */
type RecordTx = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * The address a record of `user`'s action names them by (an approval's
 * approver, a change request's author, a merge or a refusal's history),
 * read in `tx`, the transaction that writes the record.
 *
 * A person's is the address they act under. A BOT's is read from its row,
 * holding the row (`FOR SHARE`) until `tx` ends: a bots' domain change
 * re-addresses the row and moves what names it in one transaction
 * (`readdressIdentity`), and the row lock orders the two. A record written
 * after that change committed names the new address, however long ago the
 * connection resolved the bot; one whose row lock came first holds the
 * change back until it is written, and the change then moves it with the
 * rest. So no record of a bot is left at an address the bot no longer has.
 * A row that is not there (never so for a bot: its row is retired, not
 * deleted) leaves the address the call was made under.
 */
export async function recordedAddress(tx: RecordTx, user: Pick<AuthUser, 'id' | 'email' | 'madeBy'>): Promise<string> {
  if (!user.madeBy) return canonicalEmail(user.email);
  const [row] = await tx.select({ email: users.email }).from(users).where(eq(users.id, user.id)).limit(1).for('share');
  return canonicalEmail(row?.email ?? user.email);
}

/**
 * The person who made a bot's connection has no account any more: an
 * erasure committed while the call was in flight. Nothing is recorded in
 * their name; the call is refused, and the connection's next call loads
 * nothing anyway, since nobody may act as the bot through it.
 */
export class ConnectionMakerGoneError extends VersionControlDomainError {
  constructor(message = 'The person who made this connection no longer has an account, so nothing can be recorded in their name.') {
    super(message, 401, { kind: 'connection-maker-erased' });
    this.name = 'ConnectionMakerGoneError';
  }
}

/**
 * Before a record names the person behind a bot's action (`madeBy`), in
 * `tx`, the transaction that writes it: join the record writers that
 * account erasure holds off (`takeRecordWriterLock`), then make sure the
 * person still has an account, or refuse (`ConnectionMakerGoneError`).
 *
 * Erasure takes that lock exclusively before it rewrites the person out of
 * every record and deletes their row, and keeps it until it commits. So
 * there are two orderings and no third: this record commits first and the
 * erasure's rewrite takes it with the rest, or the erasure commits first and
 * this finds no account and writes nothing. By address, which is all a
 * record keeps of them; an account made again at the same address since is
 * a new person, but one who answers to the address the record names. A no-op
 * for a person's own action, which names nobody behind it.
 *
 * Call it before `recordedAddress`: the lock comes first in every writer, as
 * it does in a bots' domain change (`holdRecordWriters`), so neither can
 * wait on the other's row while holding what that one waits on.
 */
export async function holdMaker(tx: RecordTx, madeBy: { email: string } | undefined): Promise<void> {
  if (!madeBy) return;
  await takeRecordWriterLock(tx);
  const address = canonicalEmail(madeBy.email);
  const [maker] = await tx.select({ id: users.id }).from(users).where(eq(users.emailBidx, address)).limit(1);
  if (!maker) throw new ConnectionMakerGoneError();
}

/**
 * Write a record of `user`'s action that names them: `write` gets where to
 * write and the address to name. A person's write runs as it is, on `db`,
 * with the address they act under. A bot's runs in a transaction that first
 * makes sure the person behind it still has an account (`holdMaker`), then
 * reads the bot's address from its row (`recordedAddress`). A record that
 * keeps nothing of that person (`namesMaker: false`, e.g. who could not
 * apply a request, which names the bot alone) skips the first step.
 */
export async function writeNamingActor<T>(
  db: Database,
  user: Pick<AuthUser, 'id' | 'email' | 'madeBy'>,
  write: (q: Database, address: string) => Promise<T>,
  { namesMaker = true }: { namesMaker?: boolean } = {},
): Promise<T> {
  if (!user.madeBy) return write(db, canonicalEmail(user.email));
  const madeBy = user.madeBy;
  return db.transaction(async (tx) => {
    if (namesMaker) await holdMaker(tx, madeBy);
    return write(tx as unknown as Database, await recordedAddress(tx, user));
  });
}
