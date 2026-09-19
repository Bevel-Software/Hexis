import { and, eq, isNotNull, sql } from 'drizzle-orm';
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
  /** When a process took this row's git work; null when nobody holds it. */
  claimedAt: Date | null;
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
  /**
   * Take this row's git work, or report that somebody else holds it.
   *
   * The ONE guard against two processes doing git on the same branch: a
   * redeploy overlaps two servers, both sweep, and neither's in-process
   * single-flight map can see the other's. Returns the row when this caller
   * may proceed and null when it may not — so a caller that gets null does
   * nothing at all, rather than racing.
   *
   * Claims expire (see `claimed_at` on the table) so a process that dies
   * holding one does not owe the request forever.
   */
  claim(id: string, staleAfterMs: number): Promise<JoinRequestRecord | null>;
  /**
   * Say the claim on this row is still being worked — push its timestamp
   * forward. What turns `claimed_at` from a deadline into a liveness signal:
   * a process that is still going keeps its row however long the work takes,
   * and one that died stops beating and lets go within the stale window.
   */
  heartbeat(id: string): Promise<void>;
  /**
   * Give a claim back without deciding the request — the platform was not
   * ready, so the row stays `pending` and becomes claimable again at once
   * instead of after the stale window.
   */
  release(id: string): Promise<void>;
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
        // A revived row is free for the retry to claim at once; a row that is
        // already `pending` keeps whatever claim is running against it, so a
        // second click still cannot start a second job.
        claimedAt: sql`case when ${pluginJoinRequests.status} = 'failed' then null else ${pluginJoinRequests.claimedAt} end`,
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

  /**
   * One conditional UPDATE, which is what makes this a claim rather than a
   * check: the `pending` status and the free-or-stale claim are tested by the
   * database in the same statement that takes the row, so two processes
   * asking together cannot both be told yes.
   */
  async claim(id: string, staleAfterMs: number): Promise<JoinRequestRecord | null> {
    const [row] = await this.db
      .update(pluginJoinRequests)
      .set({ claimedAt: new Date() })
      .where(
        and(
          eq(pluginJoinRequests.id, id),
          eq(pluginJoinRequests.status, 'pending'),
          sql`(${pluginJoinRequests.claimedAt} is null or ${pluginJoinRequests.claimedAt} < now() - make_interval(secs => ${staleAfterMs / 1000}))`,
        ),
      )
      .returning();
    return row ? toRecord(row) : null;
  }

  async heartbeat(id: string): Promise<void> {
    // Conditional on the row still being claimed AND pending: a beat that
    // landed after the work finished must not resurrect a claim on a row
    // somebody else may by then be entitled to.
    await this.db
      .update(pluginJoinRequests)
      .set({ claimedAt: new Date() })
      .where(
        and(
          eq(pluginJoinRequests.id, id),
          eq(pluginJoinRequests.status, 'pending'),
          isNotNull(pluginJoinRequests.claimedAt),
        ),
      );
  }

  async release(id: string): Promise<void> {
    await this.db
      .update(pluginJoinRequests)
      .set({ claimedAt: null })
      .where(and(eq(pluginJoinRequests.id, id), eq(pluginJoinRequests.status, 'pending')));
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
    claimedAt: row.claimedAt,
  };
}

function isStatus(value: string): value is JoinRequestStatus {
  return value === 'pending' || value === 'opened' || value === 'failed';
}
