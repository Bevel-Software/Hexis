import { and, eq, gt, isNull } from 'drizzle-orm';
import type { Database } from '../../database/connection.js';
import { githubFacadeCodes } from '../../database/schema.js';

/**
 * A one-time code the consent page issued, waiting for Anthropic's backend
 * to exchange it. Looked up by the code's hash; the plaintext travels once,
 * in the redirect.
 */
export interface PendingFacadeCode {
  codeHash: string;
  userId: string;
  clientId: string;
  redirectUri: string;
  expiresAt: Date;
}

/**
 * Where pending codes live. The database in production, so the consent
 * finish on one replica and the exchange on another see the same row.
 *
 * The rule "one live code per person" is the TABLE'S: the person is its
 * primary key, so issuing is an upsert — the newest code overwrites the last
 * in one statement, two finishes racing each other cannot both leave a row
 * behind, and the table holds at most one row per user, which goes when the
 * user does. That is the whole bound; nothing here ever sweeps, and no
 * rotation of the client id can strand a row, because the client id is data
 * the exchange checks rather than part of the key. Spending is one
 * conditional update: the first exchange wins, on whichever replica, and
 * every later attempt finds the code spent. Nothing in memory takes part in
 * either guarantee.
 */
export interface GitHubFacadeCodeStore {
  /** Store a fresh code, replacing whatever the same person had. */
  put(code: PendingFacadeCode): Promise<void>;
  /** The live (unspent, unexpired) code with this hash, without spending it. */
  peek(codeHash: string): Promise<PendingFacadeCode | null>;
  /** Spend the code if it is live; null when it was not (unknown, spent, expired). */
  consume(codeHash: string): Promise<PendingFacadeCode | null>;
}

export class DbGitHubFacadeCodeStore implements GitHubFacadeCodeStore {
  constructor(private readonly db: Database) {}

  async put(code: PendingFacadeCode): Promise<void> {
    const fresh = {
      clientId: code.clientId,
      codeHash: code.codeHash,
      redirectUri: code.redirectUri,
      expiresAt: code.expiresAt,
      consumedAt: null,
      createdAt: new Date(),
    };
    await this.db
      .insert(githubFacadeCodes)
      .values({ userId: code.userId, ...fresh })
      .onConflictDoUpdate({ target: githubFacadeCodes.userId, set: fresh });
  }

  async peek(codeHash: string): Promise<PendingFacadeCode | null> {
    const [row] = await this.db
      .select()
      .from(githubFacadeCodes)
      .where(live(codeHash))
      .limit(1);
    return row ? toPending(row) : null;
  }

  async consume(codeHash: string): Promise<PendingFacadeCode | null> {
    const [row] = await this.db
      .update(githubFacadeCodes)
      .set({ consumedAt: new Date() })
      .where(live(codeHash))
      .returning();
    return row ? toPending(row) : null;
  }
}

/** The one definition of "live": this hash, unspent, unexpired. */
function live(codeHash: string) {
  return and(
    eq(githubFacadeCodes.codeHash, codeHash),
    isNull(githubFacadeCodes.consumedAt),
    gt(githubFacadeCodes.expiresAt, new Date()),
  );
}

function toPending(row: typeof githubFacadeCodes.$inferSelect): PendingFacadeCode {
  return {
    codeHash: row.codeHash,
    userId: row.userId,
    clientId: row.clientId,
    redirectUri: row.redirectUri,
    expiresAt: row.expiresAt,
  };
}

/**
 * For tests: the same rules over a map keyed the way the table is. Share one
 * instance to model shared storage. Check-and-mark is synchronous, as the
 * database's conditional update is atomic: two exchanges of one code cannot
 * both win here either.
 */
export class MemoryGitHubFacadeCodeStore implements GitHubFacadeCodeStore {
  private readonly rows = new Map<string, PendingFacadeCode & { consumedAt: Date | null }>();

  async put(code: PendingFacadeCode): Promise<void> {
    this.rows.set(code.userId, { ...code, consumedAt: null });
  }

  async peek(codeHash: string): Promise<PendingFacadeCode | null> {
    const row = this.findLive(codeHash);
    return row ? strip(row) : null;
  }

  async consume(codeHash: string): Promise<PendingFacadeCode | null> {
    const row = this.findLive(codeHash);
    if (!row) return null;
    row.consumedAt = new Date();
    return strip(row);
  }

  /** How many rows the store holds — at most one per person. */
  get size(): number {
    return this.rows.size;
  }

  private findLive(codeHash: string) {
    const now = Date.now();
    for (const row of this.rows.values()) {
      if (row.codeHash === codeHash && row.consumedAt === null && row.expiresAt.getTime() > now) return row;
    }
    return null;
  }
}

function strip(row: PendingFacadeCode & { consumedAt: Date | null }): PendingFacadeCode {
  return {
    codeHash: row.codeHash,
    userId: row.userId,
    clientId: row.clientId,
    redirectUri: row.redirectUri,
    expiresAt: row.expiresAt,
  };
}
