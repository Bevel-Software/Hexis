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
  /**
   * The fencing token of the claim `claimedAt` is the liveness of; null when
   * nobody holds it. A worker names this on every write that holds or decides
   * the row, so a superseded one writes nothing.
   */
  claimToken: string | null;
}

export type JoinRequestStatus = 'pending' | 'opened' | 'failed';

/**
 * A record this process HOLDS — the only shape a claim hands back, and the
 * only one the write methods below will accept a token from. Carrying the
 * token in the type is what stops a caller from settling a row it never
 * claimed: there is no token to pass unless a claim produced one.
 */
export type ClaimedJoinRequest = JoinRequestRecord & { claimToken: string };

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
   *
   * The record that comes back carries a FRESH `claimToken`, which the caller
   * names on every write after it. That is what makes the claim exclusive
   * rather than merely advisory: a worker that overran the stale window and
   * had its row taken can no longer settle the attempt that replaced it.
   */
  claim(id: string, staleAfterMs: number): Promise<ClaimedJoinRequest | null>;
  /**
   * Say the claim on this row is still being worked — push its timestamp
   * forward. What turns `claimed_at` from a deadline into a liveness signal:
   * a process that is still going keeps its row however long the work takes,
   * and one that died stops beating and lets go within the stale window.
   *
   * Answers whether the claim is still THIS caller's. False means the row
   * moved on without it: taken over after the window lapsed, settled by
   * somebody else, or deleted outright — which is the shape account erasure
   * takes. A worker that reads false has to stop before its next side effect
   * rather than finish work nobody is owed and open a change request for an
   * account that no longer exists.
   */
  heartbeat(id: string, claimToken: string): Promise<boolean>;
  /**
   * Give a claim back without deciding the request — the platform was not
   * ready, so the row stays `pending` and becomes claimable again at once
   * instead of after the stale window.
   */
  release(id: string, claimToken: string): Promise<void>;
  /**
   * The git work landed: the change request exists, under this number.
   * A no-op unless the caller still holds the claim it names.
   */
  markOpened(id: string, claimToken: string, changeRequestNumber: number): Promise<void>;
  /**
   * The git work refused, in its own words. A no-op unless the caller still
   * holds the claim it names — a superseded worker's failure must not be
   * stamped on the attempt that replaced it.
   */
  markFailed(id: string, claimToken: string, reason: string): Promise<void>;
  /**
   * The change request an `opened` row named is over — declined, withdrawn,
   * or settled and the access since taken back — so the ask is owed again:
   * the row goes back to `pending`, unclaimed and unnumbered, for the next
   * job to carry. Conditional on the row still being `opened` ON THAT
   * NUMBER, so an attempt that has since re-pointed the row at a newer
   * request is left alone. Returns the row as it stands afterwards, whether
   * or not this call changed it; null when it is gone.
   */
  reopen(id: string, changeRequestNumber: number): Promise<JoinRequestRecord | null>;
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
        claimToken: sql`case when ${pluginJoinRequests.status} = 'failed' then null else ${pluginJoinRequests.claimToken} end`,
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
  async claim(id: string, staleAfterMs: number): Promise<ClaimedJoinRequest | null> {
    const [row] = await this.db
      .update(pluginJoinRequests)
      // The token is minted by the DATABASE, in the same statement that takes
      // the row, so it is unique to this claim by construction — two callers
      // racing here cannot be handed the same one even if one of them read a
      // stale row a moment before.
      .set({ claimedAt: new Date(), claimToken: sql`gen_random_uuid()` })
      .where(
        and(
          eq(pluginJoinRequests.id, id),
          eq(pluginJoinRequests.status, 'pending'),
          sql`(${pluginJoinRequests.claimedAt} is null or ${pluginJoinRequests.claimedAt} < now() - make_interval(secs => ${staleAfterMs / 1000}))`,
        ),
      )
      .returning();
    if (!row) return null;
    const record = toRecord(row);
    // The same statement that took the row minted the token, so a returned
    // row always has one. The check is the type's rather than a real branch —
    // and if the column ever did come back null, refusing the claim is the
    // safe reading: no token, no exclusive right to the row.
    return record.claimToken ? { ...record, claimToken: record.claimToken } : null;
  }

  async heartbeat(id: string, claimToken: string): Promise<boolean> {
    // Conditional on the row still being claimed AND pending AND claimed by
    // THIS caller. Pending-and-claimed keeps a late beat from resurrecting a
    // claim on a row that has already been settled; the token keeps a worker
    // which overran the stale window from beating — and so from keeping alive
    // — a claim that now belongs to its replacement.
    const beaten = await this.db
      .update(pluginJoinRequests)
      .set({ claimedAt: new Date() })
      .where(
        and(
          eq(pluginJoinRequests.id, id),
          eq(pluginJoinRequests.status, 'pending'),
          isNotNull(pluginJoinRequests.claimedAt),
          eq(pluginJoinRequests.claimToken, claimToken),
        ),
      )
      .returning({ id: pluginJoinRequests.id });
    // Nothing matched: taken over, already settled, or the row is gone —
    // account erasure deletes it. All three mean "stop", which is why the
    // caller gets a boolean rather than silence.
    return beaten.length > 0;
  }

  async release(id: string, claimToken: string): Promise<void> {
    await this.db
      .update(pluginJoinRequests)
      .set({ claimedAt: null, claimToken: null })
      .where(
        and(
          eq(pluginJoinRequests.id, id),
          eq(pluginJoinRequests.status, 'pending'),
          eq(pluginJoinRequests.claimToken, claimToken),
        ),
      );
  }

  async markOpened(id: string, claimToken: string, changeRequestNumber: number): Promise<void> {
    await this.db
      .update(pluginJoinRequests)
      .set({
        status: 'opened',
        changeRequestNumber,
        failureReason: null,
        // The claim is spent with the outcome it decided, in one statement.
        claimedAt: null,
        claimToken: null,
        updatedAt: new Date(),
      })
      .where(and(eq(pluginJoinRequests.id, id), eq(pluginJoinRequests.claimToken, claimToken)));
  }

  async markFailed(id: string, claimToken: string, reason: string): Promise<void> {
    await this.db
      .update(pluginJoinRequests)
      .set({
        status: 'failed',
        failureReason: reason,
        claimedAt: null,
        claimToken: null,
        updatedAt: new Date(),
      })
      .where(and(eq(pluginJoinRequests.id, id), eq(pluginJoinRequests.claimToken, claimToken)));
  }

  async reopen(id: string, changeRequestNumber: number): Promise<JoinRequestRecord | null> {
    const [row] = await this.db
      .update(pluginJoinRequests)
      .set({
        status: 'pending',
        changeRequestNumber: null,
        failureReason: null,
        claimedAt: null,
        claimToken: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(pluginJoinRequests.id, id),
          eq(pluginJoinRequests.status, 'opened'),
          eq(pluginJoinRequests.changeRequestNumber, changeRequestNumber),
        ),
      )
      .returning();
    return row ? toRecord(row) : this.byId(id);
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
    claimToken: row.claimToken,
  };
}

function isStatus(value: string): value is JoinRequestStatus {
  return value === 'pending' || value === 'opened' || value === 'failed';
}
