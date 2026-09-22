import { randomUUID } from 'node:crypto';
import { logger } from '../../shared/logging.js';

const log = logger('account-erasure');
import { and, eq, notExists } from 'drizzle-orm';
import type { Database } from '../database/connection.js';
import { takeEveryApprovalLock } from '../workflow/review-workflow/approval-lock.js';
import {
  changeRequests,
  externalApiKeys,
  fileLocks,
  oauthAuthCodes,
  oauthTokens,
  pendingCommits,
  pluginJoinRequests,
  prComments,
  prFileApprovals,
  prMergeLog,
  users,
} from '../database/schema.js';

/** The anonymised id of one erasure — how a commit or log may name the account. */
export function erasedAccountId(erasureId: string): string {
  return `deleted-${erasureId}`;
}

/** The placeholder email anonymised audit rows carry for one erasure. */
export function erasedEmailFor(erasureId: string): string {
  return `${erasedAccountId(erasureId)}@erased.invalid`;
}

/** A user row as the admin surface needs it (no avatar, no timestamps churn). */
export interface AdminUserView {
  id: string;
  email: string;
  name: string;
  createdAt: number;
}

/** The drizzle client erasure participants receive inside the transaction. */
export type ErasureTx = Parameters<Parameters<Database['transaction']>[0]>[0];

/** Identity context for one erasure run. */
export interface ErasureTarget {
  userId: string;
  /** The user's (lowercased) email at erasure time — for email-keyed rows. */
  email: string;
  /**
   * Per-erasure placeholder identity for anonymized audit rows. Random per
   * erasure: no link back to the person, but rows from ONE erasure stay
   * correlated and email-keyed unique indexes can't collide across erasures.
   */
  erasedEmail: string;
  erasedName: string;
}

/**
 * A module-owned slice of account erasure. The core service erases the rows
 * it owns (tokens, locks, review-trail anonymization, the user row) and runs
 * every registered participant so each module cleans up its own tables —
 * chat threads, connector links, routine authorship, … — without the auth
 * module knowing they exist. Registered at the composition root.
 *
 *  - `before` runs OUTSIDE the transaction, first. For idempotent pre-cleanup
 *    against external stores (e.g. chat-thread message memory) where a failure
 *    must leave a retryable state, not a half-committed one.
 *  - `inTransaction` runs INSIDE the erasure transaction, BEFORE the users row
 *    is deleted (so FKs onto users are still satisfiable and RESTRICT FKs make
 *    missed rows fail loudly). It may return a callback, which runs after the
 *    transaction commits — for external-store cleanup of rows captured during
 *    the transaction.
 */
export interface IErasureParticipant {
  before?(target: ErasureTarget): Promise<void>;
  inTransaction?(tx: ErasureTx, target: ErasureTarget): Promise<void | (() => Promise<void>)>;
}

/**
 * GDPR account erasure (Art. 17). Operator-driven: an admin deletes a user in
 * response to an erasure request. What it guarantees:
 *
 *  - Rows that ARE the user's personal data are hard-deleted: API/OAuth
 *    tokens, held file locks, the user row itself, and every registered
 *    participant's module-owned rows (chat threads incl. message memory,
 *    Microsoft connection, feedback, revalidation requests, upload tokens).
 *    Deleting the user row cascades whatever FKs onto it with ON DELETE
 *    CASCADE (account links, watchlist sources/findings, connector configs,
 *    vault secrets); deleting a connection key cascades its usage metering.
 *  - Audit rows that must survive for the review trail (approvals, merge log,
 *    review comments, change requests, queued commits — and, via participants,
 *    e.g. routine authorship) are kept but ANONYMIZED with the per-erasure
 *    placeholder identity.
 *
 * Out of scope, by firm policy (disclosed in the DPA): git history is never
 * rewritten. Commit authorship and historical access-file entries stay in the
 * KB's version history permanently as part of the tamper-evident record;
 * erasure covers every database/filesystem store plus the CURRENT KB state.
 *
 * Note: sign-in is get-or-create by email, so a person who authenticates again
 * after erasure simply gets a fresh, empty account — that is intended.
 */
export interface IAccountErasureService {
  listUsers(): Promise<AdminUserView[]>;
  /**
   * Erase `userId`. Returns false when no such user exists. `erasureId` fixes
   * the anonymised identity (`deleted-<erasureId>@erased.invalid`) so a caller
   * can name the erased account elsewhere — e.g. a commit message — without
   * the email; random when omitted.
   */
  eraseUser(userId: string, opts?: { erasureId?: string }): Promise<boolean>;
}

export class AccountErasureService implements IAccountErasureService {
  constructor(
    private readonly db: Database,
    private readonly participants: IErasureParticipant[] = [],
  ) {}

  async listUsers(): Promise<AdminUserView[]> {
    const rows = await this.db
      .select({ id: users.id, email: users.email, name: users.name, createdAt: users.createdAt })
      .from(users)
      .orderBy(users.email);
    return rows.map((r) => ({ ...r, createdAt: r.createdAt.getTime() }));
  }

  async eraseUser(userId: string, opts: { erasureId?: string } = {}): Promise<boolean> {
    const [user] = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user) return false;

    const target: ErasureTarget = {
      userId,
      email: user.email.toLowerCase(),
      erasedEmail: erasedEmailFor(opts.erasureId ?? randomUUID()),
      erasedName: 'Deleted user',
    };

    // Participant pre-passes (e.g. chat threads + their Mastra memory) run
    // outside the transaction on purpose: external stores are separate
    // systems, and the pre-passes are idempotent, so a failure here leaves a
    // retryable state rather than a half-committed one.
    for (const p of this.participants) {
      if (p.before) await p.before(target);
    }

    const postCommit: Array<() => Promise<void>> = [];
    await this.db.transaction(async (tx) => {
      // Token-shaped rows (all hashed, but they key to the user). Dependents
      // like the LLM-usage metering rows cascade at the DB layer.
      await tx.delete(externalApiKeys).where(eq(externalApiKeys.userId, userId));
      await tx.delete(oauthAuthCodes).where(eq(oauthAuthCodes.userId, userId));
      await tx.delete(oauthTokens).where(eq(oauthTokens.userId, userId));

      // Personal-data rows the core owns.
      await tx.delete(fileLocks).where(eq(fileLocks.holderUserId, userId));
      // Recorded plugin join requests. DELETED, not anonymised like the audit
      // rows below: the row carries the person's address and name, it is not
      // part of the review trail (the change request it opened is, and that
      // is anonymised with the rest), and the table is unique on
      // `(requester_email, plugin_key)` — so a row left behind would be
      // INHERITED by a later account signing in with the same address, which
      // would see a stranger's request as its own and be unable to make a new
      // one. Sign-in is get-or-create by email, so that is not hypothetical.
      //
      // A JOB MAY BE MID-FLIGHT against one of these rows, and this statement
      // says nothing to it — it is a background clone and push in another
      // stack, possibly in another process, with no transaction to join. What
      // stops it opening a change request in an erased person's name is the
      // other side of the same delete: the job holds a fencing token from
      // `plugin_join_requests.claim_token`, it re-beats that claim before the
      // change request (see `PluginJoinRequestJobs.attempt`), and a beat
      // against a row that no longer exists matches nothing. The job reads
      // that as its claim being gone and stops without opening anything or
      // writing anything back — so no row is resurrected here either.
      await tx
        .delete(pluginJoinRequests)
        .where(eq(pluginJoinRequests.requesterEmail, target.email));

      // Audit rows: anonymize in place (no user FK on these; they key by email).
      //
      // The approvals are taken under the lock their own writers hold, because
      // one of those writers COPIES rows: a change request that brings itself
      // up to date re-pins the approvals its merge did not disturb onto the new
      // head. A copy that read this person's row a moment before the statement
      // below would insert their real address back afterwards — a row created
      // after the last trace of them was supposed to be gone. Exclusive here,
      // shared there: this waits for the copies in flight and holds the rest
      // off until the erasure commits, so the rewrite below is the last word.
      await takeEveryApprovalLock(tx);
      await tx
        .update(prFileApprovals)
        .set({ approverEmail: target.erasedEmail, approverName: target.erasedName })
        .where(eq(prFileApprovals.approverEmail, target.email));
      await tx
        .update(prMergeLog)
        .set({ triggeredByEmail: target.erasedEmail, triggeredByName: target.erasedName })
        .where(eq(prMergeLog.triggeredByEmail, target.email));
      await tx
        .update(prComments)
        .set({ authorEmail: target.erasedEmail, authorName: target.erasedName })
        .where(eq(prComments.authorEmail, target.email));
      await tx
        .update(changeRequests)
        .set({ authorEmail: target.erasedEmail, authorName: target.erasedName })
        .where(eq(changeRequests.authorEmail, target.email));
      // Queued-but-uncommitted saves: the eventual git commit is authored with
      // the placeholder instead of the erased identity. The file content still
      // lands — erasing an account must not lose other people's KB state.
      await tx
        .update(pendingCommits)
        .set({ authorEmail: target.erasedEmail, authorName: target.erasedName })
        .where(eq(pendingCommits.authorEmail, target.email));

      // Module-owned rows, before the users delete so FKs onto users are
      // still satisfiable — and so a participant that MISSES rows makes the
      // users delete below fail on its RESTRICT FK, rolling everything back:
      // a loud retry, never a silent orphan.
      for (const p of this.participants) {
        if (!p.inTransaction) continue;
        const cb = await p.inTransaction(tx, target);
        if (cb) postCommit.push(cb);
      }

      // Finally the user row (plus its ON DELETE CASCADE dependents).
      await tx.delete(users).where(eq(users.id, userId));
    });

    // The two second passes below run BEFORE the callbacks, not after them: a
    // callback talks to an external store and can reject, and the erasure it
    // would abandon is already committed — `eraseUser` cannot be retried into
    // it, so a pass sequenced behind a failing callback is a pass that may
    // never run at all. Nothing here depends on a callback having succeeded.

    // The second pass for the approvals, for the same kind of reason as the one
    // the change requests already had.
    //
    // The lock above orders this erasure against every writer that takes it,
    // and `approveFile` re-reads the account under that lock before it writes
    // — so an approval in flight when this commits is refused rather than
    // landing in the erased name. This is the belt to that pair of braces: it
    // costs one statement, it is idempotent, and it means the guarantee does
    // not rest on every future writer of this table remembering the lock. A
    // row that got in anyway is rewritten here.
    //
    // Only while NO account answers to the address, exactly as below: someone
    // who signs in again at it since the commit is a new person, and the
    // approvals they make are their own.
    await this.db
      .update(prFileApprovals)
      .set({ approverEmail: target.erasedEmail, approverName: target.erasedName })
      .where(
        and(
          eq(prFileApprovals.approverEmail, target.email),
          notExists(this.db.select({ id: users.id }).from(users).where(eq(users.email, target.email))),
        ),
      );

    // Once more, after the commit, for the one writer that can still be
    // holding the person's name: a join-request job that confirmed its claim
    // just before the delete above landed and opened its change request just
    // after. The delete is what stops it — the next confirmation finds no
    // row — but the open it was already inside lands in the real name. The
    // update is idempotent, so a second pass costs one statement and closes
    // that window for a request that landed by now; the job's own re-check
    // of the requester right before it opens (see `PluginJoinRequestJobs`)
    // narrows what can land after. Only while NO account answers to the
    // address: one made again with the same email since the commit is a new
    // person, and their requests are their own.
    await this.db
      .update(changeRequests)
      .set({ authorEmail: target.erasedEmail, authorName: target.erasedName })
      .where(
        and(
          eq(changeRequests.authorEmail, target.email),
          notExists(this.db.select({ id: users.id }).from(users).where(eq(users.email, target.email))),
        ),
      );

    // Post-commit callbacks (e.g. Mastra memory cleanup for chat threads
    // captured inside the transaction).
    for (const cb of postCommit) await cb();

    log.info(`erased user id=${userId}`);
    return true;
  }
}
