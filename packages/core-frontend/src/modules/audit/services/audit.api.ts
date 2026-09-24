import { authFetch } from '../../../lib/api';

/**
 * The Audit log's client: the agents and keys a person (or, for admins, the
 * deployment) has connected, what each of them called, and the revoke of
 * either. Types mirror the backend's `audit.contract.ts`; re-declared here
 * rather than shared, like the admin inbox's, because the feature is small.
 */

export type AuditPrincipalKind = 'key' | 'agent';

/** One row of the Audit log: an agent connection or a connection key, with its owner. */
export interface AuditPrincipal {
  kind: AuditPrincipalKind;
  id: string;
  /** The key's label, or the agent's registered name ("Claude"). */
  label: string;
  /** For a key: `key` by hand, `github-link` for a Claude link. Absent for an agent. */
  keyKind?: string;
  /** When the key was created / the agent connected. Epoch ms. */
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
  /** Who ended it once revoked: the owner, or an admin. Null while live. */
  revokedBy: 'owner' | 'admin' | null;
  /** For a key: when its owner deleted it for good. Only admins see such rows. */
  deletedAt?: number | null;
  /** Events on record for it. */
  eventCount: number;
  user: { id: string; email: string; name: string };
}

export type AgentEventKind = 'capability' | 'tool' | 'skill';
export type AgentEventOutcome = 'ok' | 'error' | 'denied';

export interface AgentEvent {
  id: string;
  kind: AgentEventKind;
  /** The MCP server / `.tool` manual for a tool, the skill folder for a skill; null for a capability. */
  manual: string | null;
  name: string;
  outcome: AgentEventOutcome;
  /** Epoch ms. */
  at: number;
}

export interface AgentEventPage {
  events: AgentEvent[];
  /** Every event on record for the principal — on the first page only; null on a page reached through a cursor. */
  total: number | null;
  /** Pass back as `before` for the next (older) page; null on the last. */
  nextCursor: string | null;
}

async function readError(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => ({}));
  return (body as { error?: string }).error || fallback;
}

/** Your own agents and keys, or (admins) everyone's. Ordered by owner, live first, most recently used first. */
export async function listPrincipals(scope: 'me' | 'all'): Promise<AuditPrincipal[]> {
  const res = await authFetch(`/api/audit/principals?scope=${scope}`);
  if (!res.ok) throw new Error(await readError(res, 'Could not load the audit log'));
  const body = (await res.json()) as { principals: AuditPrincipal[] };
  return body.principals;
}

/** One principal's events, newest first; `before` continues from a previous page's cursor. */
export async function listEvents(
  kind: AuditPrincipalKind,
  id: string,
  opts: { before?: string; limit?: number } = {},
): Promise<AgentEventPage> {
  const qs = new URLSearchParams();
  if (opts.before) qs.set('before', opts.before);
  if (opts.limit) qs.set('limit', String(opts.limit));
  const query = qs.toString();
  const res = await authFetch(
    `/api/audit/principals/${kind}/${encodeURIComponent(id)}/events${query ? `?${query}` : ''}`,
  );
  if (!res.ok) throw new Error(await readError(res, 'Could not load events'));
  return (await res.json()) as AgentEventPage;
}

/**
 * Cut an agent off: every token it holds stops working, and it can only
 * come back by signing in again through the browser. Its row and events stay.
 */
export async function revokeAgent(id: string): Promise<void> {
  const res = await authFetch(`/api/audit/agents/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(await readError(res, 'Could not revoke this agent'));
}

/** Revoke a connection key (own, or as an admin anyone's). The row stays so its history remains visible. */
export async function revokeKey(id: string): Promise<void> {
  const res = await authFetch(`/api/audit/keys/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(await readError(res, 'Could not revoke this key'));
}
