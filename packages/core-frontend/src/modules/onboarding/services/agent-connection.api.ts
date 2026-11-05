import { authFetch } from '../../../lib/api';

/**
 * Whether one of the signed-in person's agents has reached the platform —
 * `GET /api/onboarding/agent-connection`. MIRRORS the backend's
 * `AgentConnectionResponse` (`modules/audit/agent-connection.routes.ts`).
 *
 * "Connected" means an agent made an authenticated call with one of the
 * person's live connections or keys, which every client does the moment it
 * connects (it lists the tools) — not that it has used a tool yet.
 */
export interface AgentConnection {
  connected: boolean;
  /** The agent's most recent call, ISO 8601. Present once connected. */
  at?: string;
  /** The agent's registered client name ("Claude"), or the connection key's label. */
  client?: string;
  /**
   * Which of the two `client` is: `agent` for an OAuth connection's
   * registered name, `key` for a connection key's free-text label.
   */
  kind?: 'agent' | 'key';
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

/**
 * Throws on a refusal or a malformed body; callers read any failure as "not
 * yet". Checked field by field rather than cast: a body that is not the
 * documented shape is a failure, not a quiet "not connected" — and a
 * "connected" with a stray `client` or `kind` must not steer the first-page
 * step's links.
 */
export async function fetchAgentConnection(): Promise<AgentConnection> {
  const res = await authFetch('/api/onboarding/agent-connection');
  if (!res.ok) throw new Error(`agent-connection: ${res.status}`);
  const body: unknown = await res.json();
  if (typeof body !== 'object' || body === null || typeof (body as { connected?: unknown }).connected !== 'boolean') {
    throw new Error('agent-connection: malformed body');
  }
  const { connected, at, client, kind } = body as Record<string, unknown>;
  if (connected === false) return { connected: false };
  if (
    !optionalString(at) ||
    !optionalString(client) ||
    (kind !== undefined && kind !== 'agent' && kind !== 'key')
  ) {
    throw new Error('agent-connection: malformed body');
  }
  return { connected: true, at, client, kind };
}
