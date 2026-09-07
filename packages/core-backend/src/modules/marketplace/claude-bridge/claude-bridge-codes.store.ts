import { and, eq, gt, isNull, lt, or } from 'drizzle-orm';
import type { Database } from '../../database/connection.js';
import { claudeMarketplaceCodes } from '../../database/schema.js';

/**
 * A one-time code the consent page issued, waiting for Anthropic's backend
 * to exchange it. Keyed by the code's hash; the plaintext travels once, in
 * the redirect.
 */
export interface PendingClaudeCode {
  codeHash: string;
  userId: string;
  clientId: string;
  redirectUri: string;
  expiresAt: Date;
}

/**
 * Where pending codes live. The database in production, so the consent
 * finish on one replica and the exchange on another see the same row; and
 * ONE row per person and client, so a person mashing Finish never grows the
 * table — the newest code supersedes the last.
 *
 * Consumption is a single conditional update: the code is spent by whichever
 * exchange gets there first, on whichever replica, and every later attempt
 * finds it spent. That is the whole one-use guarantee; nothing in memory
 * takes part in it.
 */
export interface ClaudeBridgeCodeStore {
  /** Store a fresh code, replacing any live one for the same person and client. */
  put(code: PendingClaudeCode): Promise<void>;
  /** The live (unspent, unexpired) code with this hash, without spending it. */
  peek(codeHash: string): Promise<PendingClaudeCode | null>;
  /** Spend the code if it is live; null when it was not (unknown, spent, expired). */
  consume(codeHash: string): Promise<PendingClaudeCode | null>;
}

export class DbClaudeBridgeCodeStore implements ClaudeBridgeCodeStore {
  constructor(private readonly db: Database) {}

  async put(code: PendingClaudeCode): Promise<void> {
    await this.db.transaction(async (tx) => {
      // Sweep what nobody will ever exchange (expired, or spent) and this
      // person's earlier live code for the same client, then store the new one.
      await tx
        .delete(claudeMarketplaceCodes)
        .where(
          or(
            lt(claudeMarketplaceCodes.expiresAt, new Date()),
            and(
              eq(claudeMarketplaceCodes.userId, code.userId),
              eq(claudeMarketplaceCodes.clientId, code.clientId),
            ),
          ),
        );
      await tx.insert(claudeMarketplaceCodes).values({
        codeHash: code.codeHash,
        userId: code.userId,
        clientId: code.clientId,
        redirectUri: code.redirectUri,
        expiresAt: code.expiresAt,
      });
    });
  }

  async peek(codeHash: string): Promise<PendingClaudeCode | null> {
    const [row] = await this.db
      .select()
      .from(claudeMarketplaceCodes)
      .where(
        and(
          eq(claudeMarketplaceCodes.codeHash, codeHash),
          isNull(claudeMarketplaceCodes.consumedAt),
          gt(claudeMarketplaceCodes.expiresAt, new Date()),
        ),
      )
      .limit(1);
    return row ? toPending(row) : null;
  }

  async consume(codeHash: string): Promise<PendingClaudeCode | null> {
    const [row] = await this.db
      .update(claudeMarketplaceCodes)
      .set({ consumedAt: new Date() })
      .where(
        and(
          eq(claudeMarketplaceCodes.codeHash, codeHash),
          isNull(claudeMarketplaceCodes.consumedAt),
          gt(claudeMarketplaceCodes.expiresAt, new Date()),
        ),
      )
      .returning();
    return row ? toPending(row) : null;
  }
}

function toPending(row: typeof claudeMarketplaceCodes.$inferSelect): PendingClaudeCode {
  return {
    codeHash: row.codeHash,
    userId: row.userId,
    clientId: row.clientId,
    redirectUri: row.redirectUri,
    expiresAt: row.expiresAt,
  };
}

/** For tests: the same rules over a map. Share one instance to model shared storage. */
export class MemoryClaudeBridgeCodeStore implements ClaudeBridgeCodeStore {
  private readonly rows = new Map<string, PendingClaudeCode & { consumedAt: Date | null }>();

  async put(code: PendingClaudeCode): Promise<void> {
    const now = Date.now();
    for (const [hash, row] of this.rows) {
      const stale = row.expiresAt.getTime() < now;
      const superseded = row.userId === code.userId && row.clientId === code.clientId;
      if (stale || superseded) this.rows.delete(hash);
    }
    this.rows.set(code.codeHash, { ...code, consumedAt: null });
  }

  async peek(codeHash: string): Promise<PendingClaudeCode | null> {
    const row = this.rows.get(codeHash);
    return row && row.consumedAt === null && row.expiresAt.getTime() > Date.now() ? strip(row) : null;
  }

  async consume(codeHash: string): Promise<PendingClaudeCode | null> {
    const row = await this.peek(codeHash);
    if (!row) return null;
    this.rows.get(codeHash)!.consumedAt = new Date();
    return row;
  }

  /** How many rows the store holds — the bound the design promises. */
  get size(): number {
    return this.rows.size;
  }
}

function strip(row: PendingClaudeCode & { consumedAt: Date | null }): PendingClaudeCode {
  return {
    codeHash: row.codeHash,
    userId: row.userId,
    clientId: row.clientId,
    redirectUri: row.redirectUri,
    expiresAt: row.expiresAt,
  };
}
