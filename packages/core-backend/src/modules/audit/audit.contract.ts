/**
 * The Audit log's contracts: what an external agent's activity is recorded
 * as, who a recorded call is attributed to, and the two services around
 * them — the recorder the MCP proxy writes through, and the read/revoke
 * service the Audit log page is built on.
 */

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /**
       * The agent connection (`agent_connections.id`) an OAuth-authenticated
       * MCP request arrived through — bound by the MCP auth middleware from
       * the access token, or from the `connectionId` claim of the internal
       * token the local server exchanged its grant for. Unset for connection
       * keys (those carry `externalApiKeyId`) and for browser sessions.
       */
      agentConnectionId?: string;
    }
  }
}

/** What was called: the platform's own tool, a manual's tool, or a skill read. */
export type AgentEventKind = 'capability' | 'tool' | 'skill';

/**
 * How the call ended. `denied`: the caller's sign-in for the tool was
 * missing, so nothing ran. `refused`: a page made a call that needs the
 * viewer's approval (a writing tool, a tool the manual does not list, or a
 * chain) and the person viewing it answered Deny, so nothing ran.
 */
export type AgentEventOutcome = 'ok' | 'error' | 'denied' | 'refused';

/**
 * Who a call is attributed to: the connection key it was authenticated with,
 * the agent connection behind its OAuth grant, or the knowledge-base page
 * whose script made it as the person viewing it. Exactly one.
 *
 * A page has no row of its own: it is a person and a path, and its `id` is
 * both, encoded by {@link pagePrincipalId} so the Audit log's routes can name
 * it like the other two.
 */
export type AuditPrincipalRef = { kind: 'key'; id: string } | { kind: 'agent'; id: string } | { kind: 'page'; id: string };

/** Who a call is attributed to, as the recorder takes it: a page by its path, the recorder knows the person. */
export type RecordedPrincipal = { kind: 'key'; id: string } | { kind: 'agent'; id: string } | { kind: 'page'; path: string };

/** The longest page path a page principal may carry. A path is a file in the knowledge base, never longer. */
export const MAX_PAGE_PATH_LENGTH = 1024;

/**
 * A page principal's id: the person and the page's path, encoded so it is one
 * URL segment. Opaque to the client, which only ever echoes it back.
 */
export function pagePrincipalId(userId: string, path: string): string {
  return Buffer.from(`${userId}\n${path}`, 'utf8').toString('base64url');
}

/** The person and the path a page principal's id names, or null when it names none. */
export function parsePagePrincipalId(id: string): { userId: string; path: string } | null {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
  const decoded = Buffer.from(id, 'base64url').toString('utf8');
  const cut = decoded.indexOf('\n');
  if (cut < 0) return null;
  const userId = decoded.slice(0, cut);
  const path = decoded.slice(cut + 1);
  if (!isUuid(userId) || !isPagePath(path)) return null;
  return { userId, path };
}

/**
 * Whether `path` can be a page principal: a non-empty knowledge-base path of
 * printable characters, bounded. A page names itself through a request
 * header, so this is the check that keeps a line break or a control character
 * out of the log and its listing — the C1 controls (NEL among them) and the
 * Unicode line and paragraph separators included.
 */
export function isPagePath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= MAX_PAGE_PATH_LENGTH &&
    // eslint-disable-next-line no-control-regex -- the point is to refuse control characters
    !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(path)
  );
}

/** One recorded call, as the recorder takes it. */
export interface AgentEventInput {
  userId: string;
  principal: RecordedPrincipal;
  kind: AgentEventKind;
  /** The MCP server / `.tool` manual for a tool, the skill folder for a skill; null for a capability. */
  manual: string | null;
  name: string;
  outcome: AgentEventOutcome;
  durationMs: number | null;
}

/**
 * The write half. `record` never throws and never blocks the call it
 * describes: a recording failure is logged and the tool result still goes
 * back to the agent.
 */
export interface IAgentEventRecorder {
  record(event: AgentEventInput): void;
}

/** One row of the Audit log: an agent connection, a connection key or a page, with its owner. */
export interface AuditPrincipal {
  kind: 'key' | 'agent' | 'page';
  id: string;
  /** The key's label, the agent's registered client name, or the page's knowledge-base path. */
  label: string;
  /**
   * For a key: what it was minted as (`key` by hand, `github-link` for a
   * Claude link). Absent for an agent.
   */
  keyKind?: string;
  /** When the key was created / the agent connected / the page first called a tool. Epoch ms. */
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
  /** Who ended it, once revoked: the owner, or an admin. */
  revokedBy: 'owner' | 'admin' | null;
  /** For a key: when its owner deleted it for good. Such rows reach admins only. */
  deletedAt?: number | null;
  /** Events currently on record for it (within the retention window). */
  eventCount: number;
  user: { id: string; email: string; name: string };
}

/** One event as the page reads it. */
export interface AgentEventView {
  id: string;
  kind: AgentEventKind;
  manual: string | null;
  name: string;
  outcome: AgentEventOutcome;
  at: number;
}

export interface AgentEventPage {
  events: AgentEventView[];
  /**
   * Every event on record for the principal, not just this page — counted
   * on the first page only; null on a page reached through a cursor, since
   * the reader already holds the figure.
   */
  total: number | null;
  /** Pass back as `before` to load the next (older) page; null when this was the last. */
  nextCursor: string | null;
}

/** Whose rows: one person's, or the whole deployment's (admins). */
export type AuditScope = { userId: string } | 'all';

export interface IAgentAuditService {
  listPrincipals(scope: AuditScope): Promise<AuditPrincipal[]>;
  /** The account a principal belongs to, or null when there is no such principal. The routes' ownership check. */
  ownerOf(principal: AuditPrincipalRef): Promise<string | null>;
  listEvents(
    principal: AuditPrincipalRef,
    page: { before?: string; limit: number },
  ): Promise<AgentEventPage>;
  /**
   * Cut an agent off: mark its connection revoked and revoke every live
   * token it holds, so its next request fails and its refresh fails with it.
   * `ownerUserId` scopes the revoke to the person's own connections; an admin
   * passes none. Idempotent on an already-revoked connection; throws
   * {@link AuditPrincipalNotFoundError} when nothing matches.
   */
  revokeConnection(id: string, by: 'owner' | 'admin', ownerUserId?: string): Promise<void>;
}

/**
 * The most recent use of any of one person's live agents: when, what it
 * calls itself (the agent's registered client name, or the key's label), and
 * which of the two that name is.
 */
export interface AgentUse {
  at: Date;
  client: string;
  /**
   * `agent`: an OAuth connection, and `client` is the name the agent
   * registered. `key`: a connection key, and `client` is whatever label its
   * owner typed — it says nothing about which app holds the key.
   */
  kind: 'agent' | 'key';
}

/**
 * The onboarding's "is your agent connected yet?" — answered for ONE person,
 * from the use stamps the auth paths already write, so it costs two indexed
 * single-row reads and records nothing new.
 */
export interface IAgentConnectionStatus {
  /** The newest use among the person's live agent connections and connection keys; null when none has been used. */
  lastAgentUse(userId: string): Promise<AgentUse | null>;
}

export class AuditPrincipalNotFoundError extends Error {
  constructor() {
    super('No such agent, key or page');
    this.name = 'AuditPrincipalNotFoundError';
  }
}

/** A `before` cursor that is not one this service issued — the caller's mistake, answered as such. */
export class InvalidCursorError extends Error {
  constructor() {
    super('Invalid cursor');
    this.name = 'InvalidCursorError';
  }
}

/** Shape of the id columns (any uuid version; case-insensitive). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * The retention window's one rule, shared by the setting's validator and the
 * runtime reader. A positive whole number of days is the window; blank,
 * zero or a negative number is "keep forever" — the deployment's choice,
 * made the same way whether typed on the Deployment page or set through
 * `AUDIT_RETENTION_DAYS`. Anything else is not a window at all: the
 * validator refuses the save, and the reader, which cannot refuse, keeps
 * everything and says so.
 */
export type RetentionWindow = { days: number } | 'forever';

/** The window a retention setting names, or null when it names none this rule accepts. */
export function parseRetentionWindow(raw: string): RetentionWindow | null {
  const trimmed = raw.trim();
  if (trimmed === '') return 'forever';
  if (!/^-?\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return n > 0 ? { days: n } : 'forever';
}
