import { and, eq } from 'drizzle-orm';
import type { Database } from '../database/connection.js';
import { atlassianAccountLinks } from '../database/schema.js';

/**
 * Maps an outside system's account id — today an Atlassian (Forge) account —
 * to a Hexis user. Keyed on the account id because the embed always knows it
 * (`context.accountId`), unlike email which a user can hide. Written by the
 * `/embed/link` flow; read on every embed load, lock and save minted for such
 * an account, to resolve who the viewer is.
 *
 * An embed minted for a Hexis user (the MCP `open_page` path) consults none of
 * this: its token names the user id directly, so there is nothing to link.
 */
/** The account links as the embed service consumes them — the port a deployment may substitute. */
export interface IAccountLinkService {
  /** Resolve an account id to its linked Hexis user id, or null. */
  getUserId(accountId: string): Promise<string | null>;
  link(accountId: string, userId: string): Promise<void>;
  listForUser(userId: string): Promise<Array<{ atlassianAccountId: string; createdAt: Date }>>;
  unlink(userId: string, accountId: string): Promise<boolean>;
}

export class AccountLinkService implements IAccountLinkService {
  constructor(private readonly db: Database) {}

  /** Resolve an account id to its linked Hexis user id, or null. */
  async getUserId(accountId: string): Promise<string | null> {
    const [row] = await this.db
      .select()
      .from(atlassianAccountLinks)
      .where(eq(atlassianAccountLinks.atlassianAccountId, accountId))
      .limit(1);
    return row?.userId ?? null;
  }

  /** Link (or re-link) an account id to a Hexis user. Idempotent. */
  async link(accountId: string, userId: string): Promise<void> {
    await this.db
      .insert(atlassianAccountLinks)
      .values({ atlassianAccountId: accountId, userId })
      .onConflictDoUpdate({
        target: atlassianAccountLinks.atlassianAccountId,
        set: { userId, updatedAt: new Date() },
      });
  }

  /** Every account linked to `userId` (one per outside site). */
  async listForUser(userId: string): Promise<Array<{ atlassianAccountId: string; createdAt: Date }>> {
    return this.db
      .select({
        atlassianAccountId: atlassianAccountLinks.atlassianAccountId,
        createdAt: atlassianAccountLinks.createdAt,
      })
      .from(atlassianAccountLinks)
      .where(eq(atlassianAccountLinks.userId, userId));
  }

  /**
   * Remove one of `userId`'s links. Scoped to the owner — the userId
   * condition makes deleting someone else's link structurally impossible,
   * not a caller responsibility. Returns whether a row was actually removed.
   */
  async unlink(userId: string, accountId: string): Promise<boolean> {
    const deleted = await this.db
      .delete(atlassianAccountLinks)
      .where(
        and(
          eq(atlassianAccountLinks.atlassianAccountId, accountId),
          eq(atlassianAccountLinks.userId, userId),
        ),
      )
      .returning({ atlassianAccountId: atlassianAccountLinks.atlassianAccountId });
    return deleted.length > 0;
  }
}
