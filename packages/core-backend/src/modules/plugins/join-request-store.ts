import { and, asc, eq, sql } from 'drizzle-orm';
import type { Database } from '../database/connection.js';
import { pluginJoinRequests } from '../database/schema.js';
import type { JoinRequestStore, StoredRequest, StoredRequestSeed } from './join-request-queue.service.js';

type Row = typeof pluginJoinRequests.$inferSelect;

/**
 * `plugin_join_requests`, as the queue's {@link JoinRequestStore} port.
 *
 * Every rule that needs the database to arbitrate lives here rather than in
 * the queue: the duplicate gate is the table's unique index, and the retry
 * gate is a conditional UPDATE. Both are single statements, so two tabs (or a
 * click racing the boot sweep) resolve in the database and not in a read the
 * other one has already invalidated.
 */
export class PluginJoinRequestStore implements JoinRequestStore {
  constructor(private readonly db: Database) {}

  /**
   * Insert, or report the row that was already there.
   *
   * `ON CONFLICT DO NOTHING` returns nothing when it conflicts, which is
   * exactly the signal wanted: an empty `returning()` means somebody else
   * recorded this request, so this caller must not start the git work. The
   * follow-up SELECT then reads THEIR row. A read-then-insert would have both
   * tabs read "absent" and both insert.
   */
  async insertIfAbsent(seed: StoredRequestSeed): Promise<{ row: StoredRequest; inserted: boolean }> {
    const inserted = await this.db
      .insert(pluginJoinRequests)
      .values({ ...seed, status: 'pending', attempts: 1 })
      .onConflictDoNothing({
        target: [pluginJoinRequests.requesterEmail, pluginJoinRequests.pluginKey],
      })
      .returning();
    if (inserted.length > 0) return { row: toStored(inserted[0]), inserted: true };
    const [existing] = await this.db
      .select()
      .from(pluginJoinRequests)
      .where(
        and(
          eq(pluginJoinRequests.requesterEmail, seed.requesterEmail),
          eq(pluginJoinRequests.pluginKey, seed.pluginKey),
        ),
      )
      .limit(1);
    // The conflicting row can only be gone if it was retired between the two
    // statements — vanishingly rare, and a plain retry is the honest answer.
    if (!existing) return this.insertIfAbsent(seed);
    return { row: toStored(existing), inserted: false };
  }

  /**
   * Flip one FAILED row back to pending, clearing the reason. Conditional on
   * `status = 'failed'` so two clicks on a failed request start the work once.
   */
  async reopenIfFailed(id: string): Promise<StoredRequest | null> {
    const rows = await this.db
      .update(pluginJoinRequests)
      .set({
        status: 'pending',
        failureReason: null,
        attempts: sql`${pluginJoinRequests.attempts} + 1`,
        updatedAt: new Date(),
      })
      .where(and(eq(pluginJoinRequests.id, id), eq(pluginJoinRequests.status, 'failed')))
      .returning();
    return rows.length > 0 ? toStored(rows[0]) : null;
  }

  async byId(id: string): Promise<StoredRequest | null> {
    const [row] = await this.db
      .select()
      .from(pluginJoinRequests)
      .where(eq(pluginJoinRequests.id, id))
      .limit(1);
    return row ? toStored(row) : null;
  }

  async byRequester(email: string): Promise<StoredRequest[]> {
    const rows = await this.db
      .select()
      .from(pluginJoinRequests)
      .where(eq(pluginJoinRequests.requesterEmail, email));
    return rows.map(toStored);
  }

  async allPending(): Promise<StoredRequest[]> {
    const rows = await this.db
      .select()
      .from(pluginJoinRequests)
      .where(eq(pluginJoinRequests.status, 'pending'))
      .orderBy(asc(pluginJoinRequests.createdAt));
    return rows.map(toStored);
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

  async remove(id: string): Promise<void> {
    await this.db.delete(pluginJoinRequests).where(eq(pluginJoinRequests.id, id));
  }
}

function toStored(row: Row): StoredRequest {
  return {
    id: row.id,
    requesterEmail: row.requesterEmail,
    requesterName: row.requesterName,
    requesterUserId: row.requesterUserId,
    pluginKey: row.pluginKey,
    pluginFolder: row.pluginFolder,
    pluginDisplayName: row.pluginDisplayName,
    // The column is a plain text with a CHECK constraint behind it; the union
    // is the schema's promise, not something to re-derive here.
    status: row.status as StoredRequest['status'],
    changeRequestNumber: row.changeRequestNumber,
    failureReason: row.failureReason,
    attempts: row.attempts,
  };
}
