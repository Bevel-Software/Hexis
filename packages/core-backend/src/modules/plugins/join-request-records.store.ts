import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../database/connection.js';
import { pluginJoinRequests } from '../database/schema.js';

/**
 * A join request as the platform recorded it — the durable "this person
 * asked", which the change request is a consequence of rather than the same
 * event as. See `plugin_join_requests` in `core-schema.ts` for why it is a
 * row and not a queue in memory.
 */
export interface JoinRequestRecord {
  id: string;
  /** Lowercased — the identity the join branch is cut from. */
  requesterEmail: string;
  requesterName: string;
  /** The plugin's primary folder BELOW the plugins root (`Finance`, `teams/GTM`). */
  pluginKey: string;
  status: JoinRequestStatus;
  /** What the git work said when it refused; null unless `failed`. */
  failureReason: string | null;
  /** The change request the git work opened; null until it exists. */
  changeRequestNumber: number | null;
}

export type JoinRequestStatus = 'pending' | 'opened' | 'failed';

/**
 * Where join requests are recorded.
 *
 * Every method is ONE statement, which is what makes the guarantees the
 * table's rather than a caller's: two tabs clicking at the same moment both
 * land on the same row because `(requester_email, plugin_key)` is unique, and
 * neither has to have read the other's write first.
 */
export interface JoinRequestStore {
  /**
   * Record the ask. A first ask inserts `pending`; a second one finds the
   * row — reviving a `failed` record to `pending` so the retry continues the
   * recorded request, and leaving a `pending` or `opened` one exactly as it
   * is so a second click cannot restart work already under way.
   */
  record(input: { requesterEmail: string; requesterName: string; pluginKey: string }): Promise<JoinRequestRecord>;
  /** One record as it stands NOW, or null when it is gone. */
  byId(id: string): Promise<JoinRequestRecord | null>;
  /** Every record this person has, for the plugin listing. */
  forRequester(requesterEmail: string): Promise<JoinRequestRecord[]>;
  /** Every record still `pending` — what the boot sweep re-runs. */
  pending(): Promise<JoinRequestRecord[]>;
  /** The git work landed: the change request exists, under this number. */
  markOpened(id: string, changeRequestNumber: number): Promise<void>;
  /** The git work refused, in its own words. */
  markFailed(id: string, reason: string): Promise<void>;
}

export class DbJoinRequestStore implements JoinRequestStore {
  constructor(private readonly db: Database) {}

  async record(input: {
    requesterEmail: string;
    requesterName: string;
    pluginKey: string;
  }): Promise<JoinRequestRecord> {
    const requesterEmail = input.requesterEmail.toLowerCase();
    const [inserted] = await this.db
      .insert(pluginJoinRequests)
      .values({ requesterEmail, requesterName: input.requesterName, pluginKey: input.pluginKey })
      .onConflictDoNothing({
        target: [pluginJoinRequests.requesterEmail, pluginJoinRequests.pluginKey],
      })
      .returning();
    if (inserted) return toRecord(inserted);
    // Already recorded. The CASE is what keeps the revival to one statement:
    // whether this ask is a retry is decided by the row as the database reads
    // it, not by a value this process read a moment ago and may have lost a
    // race over.
    const [row] = await this.db
      .update(pluginJoinRequests)
      .set({
        requesterName: input.requesterName,
        status: sql`case when ${pluginJoinRequests.status} = 'failed' then 'pending' else ${pluginJoinRequests.status} end`,
        failureReason: sql`case when ${pluginJoinRequests.status} = 'failed' then null else ${pluginJoinRequests.failureReason} end`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(pluginJoinRequests.requesterEmail, requesterEmail),
          eq(pluginJoinRequests.pluginKey, input.pluginKey),
        ),
      )
      .returning();
    return toRecord(row);
  }

  async byId(id: string): Promise<JoinRequestRecord | null> {
    const [row] = await this.db
      .select()
      .from(pluginJoinRequests)
      .where(eq(pluginJoinRequests.id, id))
      .limit(1);
    return row ? toRecord(row) : null;
  }

  async forRequester(requesterEmail: string): Promise<JoinRequestRecord[]> {
    const rows = await this.db
      .select()
      .from(pluginJoinRequests)
      .where(eq(pluginJoinRequests.requesterEmail, requesterEmail.toLowerCase()));
    return rows.map(toRecord);
  }

  async pending(): Promise<JoinRequestRecord[]> {
    const rows = await this.db
      .select()
      .from(pluginJoinRequests)
      .where(eq(pluginJoinRequests.status, 'pending'));
    return rows.map(toRecord);
  }

  async markOpened(id: string, changeRequestNumber: number): Promise<void> {
    await this.db
      .update(pluginJoinRequests)
      .set({ status: 'opened', changeRequestNumber, failureReason: null, updatedAt: new Date() })
      .where(eq(pluginJoinRequests.id, id));
  }

  async markFailed(id: string, reason: string): Promise<void> {
    await this.db
      .update(pluginJoinRequests)
      .set({ status: 'failed', failureReason: reason, updatedAt: new Date() })
      .where(eq(pluginJoinRequests.id, id));
  }
}

function toRecord(row: typeof pluginJoinRequests.$inferSelect): JoinRequestRecord {
  return {
    id: row.id,
    requesterEmail: row.requesterEmail,
    requesterName: row.requesterName,
    pluginKey: row.pluginKey,
    // The column is `text` with a CHECK; the check is what makes this cast
    // honest, and a row that somehow escaped it reads as `pending` rather
    // than as a status nothing handles.
    status: isStatus(row.status) ? row.status : 'pending',
    failureReason: row.failureReason,
    changeRequestNumber: row.changeRequestNumber,
  };
}

function isStatus(value: string): value is JoinRequestStatus {
  return value === 'pending' || value === 'opened' || value === 'failed';
}
