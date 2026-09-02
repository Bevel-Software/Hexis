import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { blindIndex } from '../../shared/column-crypto.js';
import type { Database } from '../database/connection.js';
import {
  changeRequests,
  externalApiKeys,
  fileLocks,
  oauthAuthCodes,
  oauthTokens,
  pendingCommits,
  prComments,
  prFileApprovals,
  prMergeLog,
  users,
} from '../database/schema.js';

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
  /** Erase `userId`. Returns false when no such user exists. */
  eraseUser(userId: string): Promise<boolean>;
}

export class AccountErasureService implements IAccountErasureService {
  constructor(
    private readonly db: Database,
    private readonly participants: IErasureParticipant[] = [],
  ) {}

  async listUsers(): Promise<AdminUserView[]> {
    // Sorted in-process: `email` is ciphertext in the DB, so ORDER BY would
    // sort by IV noise. One row per team member — negligible.
    const rows = await this.db
      .select({ id: users.id, email: users.email, name: users.name, createdAt: users.createdAt })
      .from(users);
    return rows
      .map((r) => ({ ...r, createdAt: r.createdAt.getTime() }))
      .sort((a, b) => a.email.localeCompare(b.email));
  }

  async eraseUser(userId: string): Promise<boolean> {
    const [user] = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user) return false;

    const target: ErasureTarget = {
      userId,
      email: user.email.toLowerCase(),
      erasedEmail: `deleted-${randomUUID()}@erased.invalid`,
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

      // Audit rows: anonymize in place (no user FK on these; they key by
      // email). Matched via the blind index — the email columns are randomized
      // ciphertext — and the bidx is rewritten to the placeholder's too, so no
      // residual value keyed to the erased address survives the erasure.
      const emailBidx = blindIndex(target.email);
      const erasedBidx = blindIndex(target.erasedEmail);
      await tx
        .update(prFileApprovals)
        .set({
          approverEmail: target.erasedEmail,
          approverEmailBidx: erasedBidx,
          approverName: target.erasedName,
        })
        .where(eq(prFileApprovals.approverEmailBidx, emailBidx));
      await tx
        .update(prMergeLog)
        .set({
          triggeredByEmail: target.erasedEmail,
          triggeredByEmailBidx: erasedBidx,
          triggeredByName: target.erasedName,
        })
        .where(eq(prMergeLog.triggeredByEmailBidx, emailBidx));
      await tx
        .update(prComments)
        .set({
          authorEmail: target.erasedEmail,
          authorEmailBidx: erasedBidx,
          authorName: target.erasedName,
        })
        .where(eq(prComments.authorEmailBidx, emailBidx));
      await tx
        .update(changeRequests)
        .set({
          authorEmail: target.erasedEmail,
          authorEmailBidx: erasedBidx,
          authorName: target.erasedName,
        })
        .where(eq(changeRequests.authorEmailBidx, emailBidx));
      // Queued-but-uncommitted saves: the eventual git commit is authored with
      // the placeholder instead of the erased identity. The file content still
      // lands — erasing an account must not lose other people's KB state.
      await tx
        .update(pendingCommits)
        .set({
          authorEmail: target.erasedEmail,
          authorEmailBidx: erasedBidx,
          authorName: target.erasedName,
        })
        .where(eq(pendingCommits.authorEmailBidx, emailBidx));

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

    // Post-commit callbacks (e.g. Mastra memory cleanup for chat threads
    // captured inside the transaction).
    for (const cb of postCommit) await cb();

    console.log(`[account-erasure] erased user id=${userId}`);
    return true;
  }
}
