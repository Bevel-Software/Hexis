import { and, asc, count, desc, eq, isNull, lt, or, type SQL } from 'drizzle-orm';
import { logger } from '../../shared/logging.js';
import type { Database } from '../database/connection.js';
import { agentConnections, agentEvents, externalApiKeys, oauthTokens, users } from '../database/schema.js';
import type { IExternalApiKeyService } from '../tool-auth/external-api-key.interface.js';
import {
  AuditPrincipalNotFoundError,
  DEFAULT_RETENTION_DAYS,
  InvalidCursorError,
  isUuid,
  parseRetentionDays,
  type AgentEventInput,
  type AgentEventPage,
  type AgentEventView,
  type AuditPrincipal,
  type AuditPrincipalRef,
  type AuditScope,
  type IAgentAuditService,
  type IAgentEventRecorder,
} from './audit.contract.js';

const log = logger('audit');

/** The most events one page may carry; the routes clamp to it. */
export const MAX_EVENT_PAGE = 200;

/** How often, at most, one process sweeps events past the retention window. */
const PRUNE_INTERVAL_MS = 60 * 60_000;

export { DEFAULT_RETENTION_DAYS };

/**
 * The Audit log: the write half the MCP proxy records through, and the read
 * and revoke half its page is built on.
 *
 * Writes are fire-and-forget by contract — a tool result must never wait on,
 * or fail over, its own bookkeeping. Retention is enforced opportunistically
 * on the write path (one sweep per process per hour, piggybacked on an
 * insert), the same way the OAuth tables prune themselves on mint: no
 * scheduler, and a deployment that records nothing has nothing to sweep.
 *
 * Connection keys are read through the key service rather than joined here,
 * so their summary shape (kind, revoked-by, …) has exactly one definition.
 */
export class AgentAuditService implements IAgentAuditService, IAgentEventRecorder {
  private lastPruneAt = 0;

  constructor(
    private readonly db: Database,
    private readonly keys: Pick<IExternalApiKeyService, 'listForUser' | 'listForDeployment'>,
    /** Read per sweep, so a changed setting applies without a restart. */
    private readonly retentionDays: () => number,
    private readonly now: () => number = Date.now,
  ) {}

  record(event: AgentEventInput): void {
    this.db
      .insert(agentEvents)
      .values({
        userId: event.userId,
        keyId: event.principal.kind === 'key' ? event.principal.id : null,
        connectionId: event.principal.kind === 'agent' ? event.principal.id : null,
        kind: event.kind,
        manual: event.manual,
        name: event.name,
        outcome: event.outcome,
        durationMs: event.durationMs,
        at: new Date(this.now()),
      })
      .then(
        () => this.maybePrune(),
        (err) => log.warn('recording an agent event failed:', { err }),
      );
  }

  /**
   * Sweep events older than the retention window — at most once per hour per
   * process, best-effort, never awaited by a caller.
   */
  private async maybePrune(): Promise<void> {
    const now = this.now();
    if (now - this.lastPruneAt < PRUNE_INTERVAL_MS) return;
    this.lastPruneAt = now;
    const days = this.retentionDays();
    const cutoff = new Date(now - days * 24 * 60 * 60_000);
    try {
      await this.db.delete(agentEvents).where(lt(agentEvents.at, cutoff));
    } catch (err) {
      log.warn('agent-event prune failed (non-fatal):', { err });
    }
  }

  async listPrincipals(scope: AuditScope): Promise<AuditPrincipal[]> {
    const mine = scope === 'all' ? null : scope.userId;
    const [keyRows, connectionRows, countRows] = await Promise.all([
      mine === null ? this.keys.listForDeployment() : this.keysForUser(mine),
      this.db
        .select({
          connection: agentConnections,
          user: { id: users.id, email: users.email, name: users.name },
        })
        .from(agentConnections)
        .innerJoin(users, eq(agentConnections.userId, users.id))
        .where(mine === null ? undefined : eq(agentConnections.userId, mine))
        .orderBy(asc(users.email), desc(agentConnections.connectedAt)),
      this.db
        .select({ keyId: agentEvents.keyId, connectionId: agentEvents.connectionId, n: count() })
        .from(agentEvents)
        .where(mine === null ? undefined : eq(agentEvents.userId, mine))
        .groupBy(agentEvents.keyId, agentEvents.connectionId),
    ]);

    const counts = new Map<string, number>();
    for (const row of countRows) {
      const id = row.keyId ?? row.connectionId;
      if (id) counts.set(id, Number(row.n));
    }

    const principals: AuditPrincipal[] = [
      ...keyRows.map((k) => ({
        kind: 'key' as const,
        id: k.id,
        label: k.label,
        keyKind: k.kind,
        createdAt: k.createdAt,
        lastUsedAt: k.lastUsedAt,
        revokedAt: k.revokedAt,
        revokedBy: k.revokedBy,
        eventCount: counts.get(k.id) ?? 0,
        user: k.user,
      })),
      ...connectionRows.map(({ connection: c, user }) => ({
        kind: 'agent' as const,
        id: c.id,
        label: c.clientName ?? 'Unnamed agent',
        createdAt: c.connectedAt.getTime(),
        lastUsedAt: c.lastUsedAt ? c.lastUsedAt.getTime() : null,
        revokedAt: c.revokedAt ? c.revokedAt.getTime() : null,
        revokedBy: (c.revokedBy as 'owner' | 'admin' | null) ?? null,
        eventCount: counts.get(c.id) ?? 0,
        user,
      })),
    ];
    // Per account (by email), live before revoked, most recently used first,
    // newest first among the never-used — the order the page shows without
    // re-sorting, and the one the Connection keys overview had.
    principals.sort((a, b) => {
      const byEmail = a.user.email.localeCompare(b.user.email);
      if (byEmail !== 0) return byEmail;
      const aRevoked = a.revokedAt !== null;
      const bRevoked = b.revokedAt !== null;
      if (aRevoked !== bRevoked) return aRevoked ? 1 : -1;
      const byUse = (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0);
      return byUse !== 0 ? byUse : b.createdAt - a.createdAt;
    });
    return principals;
  }

  /** One person's keys, with the owner attached the way the deployment listing attaches it. */
  private async keysForUser(userId: string) {
    const [keys, [user]] = await Promise.all([
      this.keys.listForUser(userId),
      this.db
        .select({ id: users.id, email: users.email, name: users.name })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1),
    ]);
    if (!user) return [];
    return keys.map((k) => ({ ...k, user }));
  }

  async ownerOf(principal: AuditPrincipalRef): Promise<string | null> {
    if (principal.kind === 'agent') {
      const [row] = await this.db
        .select({ userId: agentConnections.userId })
        .from(agentConnections)
        .where(eq(agentConnections.id, principal.id))
        .limit(1);
      return row?.userId ?? null;
    }
    // Keys are the key service's, but it exposes no owner lookup by id; the
    // events table is not the answer either (a key with no events has an
    // owner too), so read the one column straight off the row.
    const [row] = await this.db
      .select({ userId: externalApiKeys.userId })
      .from(externalApiKeys)
      .where(eq(externalApiKeys.id, principal.id))
      .limit(1);
    return row?.userId ?? null;
  }

  async listEvents(
    principal: AuditPrincipalRef,
    page: { before?: string; limit: number },
  ): Promise<AgentEventPage> {
    const limit = Math.max(1, Math.min(MAX_EVENT_PAGE, Math.floor(page.limit)));
    const byPrincipal =
      principal.kind === 'key'
        ? eq(agentEvents.keyId, principal.id)
        : eq(agentEvents.connectionId, principal.id);
    // Keyset on (at, id): a page boundary between two events at the same
    // instant is still a boundary, and a row inserted while the reader pages
    // never shifts what the next page returns.
    const cursor = page.before ? parseCursor(page.before) : null;
    if (page.before && !cursor) throw new InvalidCursorError();
    const after: SQL | undefined = cursor
      ? or(
          lt(agentEvents.at, cursor.at),
          and(eq(agentEvents.at, cursor.at), lt(agentEvents.id, cursor.id)),
        )
      : undefined;
    const [rows, [{ total }]] = await Promise.all([
      this.db
        .select({
          id: agentEvents.id,
          kind: agentEvents.kind,
          manual: agentEvents.manual,
          name: agentEvents.name,
          outcome: agentEvents.outcome,
          at: agentEvents.at,
        })
        .from(agentEvents)
        .where(and(byPrincipal, after))
        .orderBy(desc(agentEvents.at), desc(agentEvents.id))
        .limit(limit + 1),
      this.db.select({ total: count() }).from(agentEvents).where(byPrincipal),
    ]);
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const events: AgentEventView[] = pageRows.map((r) => ({
      id: r.id,
      kind: r.kind as AgentEventView['kind'],
      manual: r.manual,
      name: r.name,
      outcome: r.outcome as AgentEventView['outcome'],
      at: r.at.getTime(),
    }));
    const last = pageRows[pageRows.length - 1];
    return {
      events,
      total: Number(total),
      nextCursor: hasMore && last ? formatCursor(last.at, last.id) : null,
    };
  }

  async revokeConnection(id: string, by: 'owner' | 'admin', ownerUserId?: string): Promise<void> {
    const scope = ownerUserId
      ? and(eq(agentConnections.id, id), eq(agentConnections.userId, ownerUserId))!
      : eq(agentConnections.id, id);
    await this.db.transaction(async (tx) => {
      const revoked = await tx
        .update(agentConnections)
        .set({ revokedAt: new Date(this.now()), revokedBy: by })
        .where(and(scope, isNull(agentConnections.revokedAt)))
        .returning({ id: agentConnections.id });
      if (revoked.length === 0) {
        // Already revoked stays idempotent; out of scope or unknown throws —
        // the same split `ExternalApiKeyService.markRevoked` makes.
        const [existing] = await tx
          .select({ id: agentConnections.id })
          .from(agentConnections)
          .where(scope)
          .limit(1);
        if (!existing) throw new AuditPrincipalNotFoundError();
        return;
      }
      // Every live token of the connection, access and refresh alike: the
      // agent's next request 401s, its refresh fails, and re-authorizing —
      // through the browser, as a person — is the only way back in.
      await tx
        .update(oauthTokens)
        .set({ revokedAt: new Date(this.now()) })
        .where(and(eq(oauthTokens.connectionId, id), isNull(oauthTokens.revokedAt)));
    });
  }
}

/** `<epoch ms>.<uuid>` — the page's opaque-enough cursor. */
function formatCursor(at: Date, id: string): string {
  return `${at.getTime()}.${id}`;
}

/**
 * The cursor back into its parts, or null for anything this service did not
 * issue: the id must be a uuid (the column is one, and Postgres refuses to
 * compare it with anything else) and the instant a whole number of epoch
 * milliseconds a `timestamp` can hold.
 */
function parseCursor(raw: string): { at: Date; id: string } | null {
  const dot = raw.indexOf('.');
  if (dot < 0) return null;
  const msText = raw.slice(0, dot);
  const id = raw.slice(dot + 1);
  if (!/^\d{1,15}$/.test(msText) || !isUuid(id)) return null;
  return { at: new Date(Number(msText)), id };
}

/** The retention window the service runs on: the setting's days when it names a valid window, else the default. */
export function retentionDaysFrom(raw: string): number {
  return parseRetentionDays(raw) ?? DEFAULT_RETENTION_DAYS;
}
