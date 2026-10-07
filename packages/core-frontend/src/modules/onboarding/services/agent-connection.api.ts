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
}

/** Throws on a refusal or a malformed body; callers read any failure as "not yet". */
export async function fetchAgentConnection(): Promise<AgentConnection> {
  const res = await authFetch('/api/onboarding/agent-connection');
  if (!res.ok) throw new Error(`agent-connection: ${res.status}`);
  const body = (await res.json()) as Partial<AgentConnection>;
  return body.connected === true
    ? { connected: true, at: body.at, client: body.client }
    : { connected: false };
}
