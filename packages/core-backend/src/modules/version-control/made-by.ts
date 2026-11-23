import { eq } from 'drizzle-orm';
import type { AuthUser } from '@bevel-software/platform-shared';
import { users, type Database } from '../database/index.js';
import { canonicalEmail } from '../../shared/email-identity.js';
import { VersionControlDomainError } from '../../shared/domain-errors.js';
import { logger } from '../../shared/logging.js';
import {
  APPROVAL_LOCK_TIMEOUT_MS,
  isApprovalLockTimeout,
  takeRecordWriterLock,
} from './change-request-review/approval-lock.js';

const log = logger('made-by');

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
 */
export async function holdMaker(tx: RecordTx, madeBy: { email: string } | undefined): Promise<void> {
  if (!madeBy) return;
  await takeRecordWriterLock(tx);
  const address = canonicalEmail(madeBy.email);
  const [maker] = await tx.select({ id: users.id }).from(users).where(eq(users.emailBidx, address)).limit(1);
  if (!maker) throw new ConnectionMakerGoneError();
}

/**
 * A record naming the person behind a bot waited for the record writers'
 * lock (`holdMaker`) longer than its bound: an account erasure held it. Nothing was written; retryable by
 * the caller, as an approval write that waited too long is.
 */
export class RecordWriterBusyError extends VersionControlDomainError {
  constructor() {
    super('This could not be recorded right now. Try that again in a moment.', 503, {
      kind: 'record-write-busy',
      retryable: true,
    });
    this.name = 'RecordWriterBusyError';
  }
}

/**
 * Run `write` in the one kind of transaction a record naming the person
 * behind a bot is written in: `holdMaker` first (unless the record keeps
 * nothing of them, `namesMaker: false`), then `write`. A wait on the
 * writers' lock past its bound is answered as `RecordWriterBusyError`, never
 * as the raw database error. Every such record goes through here or, for an
 * approval, through the approval lock, which answers its own busy refusal;
 * the one exception is a queued save, which is never refused, because its
 * bytes are already on disk (`PendingCommitsService.enqueue`).
 */
export async function inMakerTransaction<T>(
  db: Database,
  madeBy: { email: string },
  write: (tx: RecordTx) => Promise<T>,
  { namesMaker = true }: { namesMaker?: boolean } = {},
): Promise<T> {
  try {
    return await db.transaction(async (tx) => {
      if (namesMaker) await holdMaker(tx, madeBy);
      return write(tx);
    });
  } catch (err) {
    if (isApprovalLockTimeout(err)) {
      log.warn(`gave up waiting for the record writers' lock after ${APPROVAL_LOCK_TIMEOUT_MS}ms`);
      throw new RecordWriterBusyError();
    }
    throw err;
  }
}

/**
 * Write a record of `user`'s action that names them: `write` gets where to
 * write and the address to name, the address `user` acts under. A person's
 * write runs as it is, on `db`. A bot's runs in `inMakerTransaction`,
 * which first makes sure the person behind it still has an account
 * (`holdMaker`). A record that keeps nothing of that person
 * (`namesMaker: false`, e.g. who could not apply a request, which names the
 * bot alone) skips the first step.
 */
export async function writeNamingActor<T>(
  db: Database,
  user: Pick<AuthUser, 'id' | 'email' | 'madeBy'>,
  write: (q: Database, address: string) => Promise<T>,
  { namesMaker = true }: { namesMaker?: boolean } = {},
): Promise<T> {
  const address = canonicalEmail(user.email);
  if (!user.madeBy) return write(db, address);
  return inMakerTransaction(db, user.madeBy, async (tx) => write(tx as unknown as Database, address), { namesMaker });
}
