import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Database } from '../database/connection.js';
import { groupAccessRequests } from '../database/schema.js';

/** One stored request row, in the shape the routes consume. */
export interface AccessRequestRow {
  id: string;
  groupName: string;
  requesterEmail: string;
  requesterName: string;
  createdAt: Date;
}

/**
 * Ceiling on one `pendingAll()` read.
 *
 * The admin route resolves access per DISTINCT requester, and those verdicts
 * do not share a cache entry across principals — so an unbounded backlog turns
 * one admin page load into unbounded work. Oldest-first means the cap drops the
 * NEWEST rows, which a later load still finds; nothing is lost, it is deferred.
 * Well above any real pending queue, low enough that a runaway one cannot take
 * the endpoint down.
 */
export const PENDING_SCAN_LIMIT = 500;

/**
 * Storage for group access requests. Postgres only — this service writes no KB
 * files: the ONE write path into the knowledge base for access remains the
 * existing grant/revoke direct-commit flow, which is also what RESOLVES these
 * rows (see `markFulfilled`).
 */
export class AccessRequestsService {
  constructor(private readonly db: Database) {}

  /**
   * Record a request. Idempotent: the partial unique index allows at most one
   * PENDING row per (group, requester), and `onConflictDoNothing` turns a
   * repeat — a double click, a retry, a second tab — into a no-op rather than
   * an error the caller has to distinguish from a real failure.
   *
   * UNTARGETED on purpose. drizzle 0.45's `onConflictDoNothing` config accepts
   * `target` + `where`, not the `targetWhere` a PARTIAL index needs to be named
   * as an arbiter — and an untargeted `DO NOTHING` lets Postgres arbitrate on
   * any constraint, which is exactly the one partial index this table has.
   * Behaviour is identical; the constraint, not the statement, is what makes
   * the second insert a no-op.
   */
  async create(group: string, requesterEmail: string, requesterName: string): Promise<void> {
    await this.db
      .insert(groupAccessRequests)
      .values({
        groupName: group,
        requesterEmail: requesterEmail.toLowerCase(),
        requesterName,
      })
      .onConflictDoNothing();
  }

  /** The caller's own pending requests — drives `hasRequested`. */
  async pendingByRequester(email: string): Promise<{ id: string; groupName: string }[]> {
    return this.db
      .select({ id: groupAccessRequests.id, groupName: groupAccessRequests.groupName })
      .from(groupAccessRequests)
      .where(
        and(
          eq(groupAccessRequests.requesterEmail, email.toLowerCase()),
          eq(groupAccessRequests.status, 'pending'),
        ),
      );
  }

  /**
   * Pending requests, oldest first, capped at {@link PENDING_SCAN_LIMIT}. The
   * route filters the page to the caller's groups.
   */
  async pendingAll(limit: number = PENDING_SCAN_LIMIT): Promise<AccessRequestRow[]> {
    return this.db
      .select({
        id: groupAccessRequests.id,
        groupName: groupAccessRequests.groupName,
        requesterEmail: groupAccessRequests.requesterEmail,
        requesterName: groupAccessRequests.requesterName,
        createdAt: groupAccessRequests.createdAt,
      })
      .from(groupAccessRequests)
      .where(eq(groupAccessRequests.status, 'pending'))
      .orderBy(asc(groupAccessRequests.createdAt))
      .limit(limit);
  }

  /** One pending row by id, or null when it's missing or already settled. */
  async getPending(id: string): Promise<AccessRequestRow | null> {
    const rows = await this.db
      .select({
        id: groupAccessRequests.id,
        groupName: groupAccessRequests.groupName,
        requesterEmail: groupAccessRequests.requesterEmail,
        requesterName: groupAccessRequests.requesterName,
        createdAt: groupAccessRequests.createdAt,
      })
      .from(groupAccessRequests)
      .where(and(eq(groupAccessRequests.id, id), eq(groupAccessRequests.status, 'pending')))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Retire rows whose requester can now read the group. `resolved_by_email`
   * stays null: nobody clicked "approve" — granting read was the approval.
   */
  async markFulfilled(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.db
      .update(groupAccessRequests)
      .set({ status: 'fulfilled', resolvedAt: new Date() })
      .where(and(inArray(groupAccessRequests.id, ids), eq(groupAccessRequests.status, 'pending')));
  }

  /**
   * Admin says no. Atomic (`WHERE … AND status = 'pending'` + `RETURNING`) so
   * two admins racing, or a dismiss racing a lazy fulfillment, settles in the
   * database instead of in a read-modify-write window. Returns whether THIS
   * call is the one that changed the row.
   */
  async dismiss(id: string, byEmail: string): Promise<boolean> {
    const changed = await this.db
      .update(groupAccessRequests)
      .set({
        status: 'dismissed',
        resolvedAt: new Date(),
        resolvedByEmail: byEmail.toLowerCase(),
      })
      .where(and(eq(groupAccessRequests.id, id), eq(groupAccessRequests.status, 'pending')))
      .returning({ id: groupAccessRequests.id });
    return changed.length > 0;
  }
}
