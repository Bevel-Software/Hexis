import { authFetch } from '../../../lib/api';

/**
 * Connecting as an agent: an MCP connection or a connection key is made as
 * Everything (all the person may read) or as one agent configuration of the
 * knowledge base, whose lists narrow what the connection loads. What a
 * configuration is — the file kind, what it says — is the distribution's;
 * this mirrors the backend's `modules/agent-scope` contract, which only
 * names the configuration by its path.
 */

/** One agent configuration the signed-in person may connect as. */
export interface AgentChoice {
  /** Repo-relative path of the configuration — what the connection records. */
  path: string;
  /** Its name, as the choice shows it. */
  name: string;
  /** Its description, one line; empty when it has none. */
  description: string;
}

/** The agents a connection key may be minted as (the OAuth consent step gets the same list with its request). */
export async function listAgentChoices(): Promise<AgentChoice[]> {
  const res = await authFetch('/api/mcp/agent-choices');
  if (!res.ok) throw new Error("Couldn't load the agents you can connect as.");
  const body = (await res.json()) as { agents?: AgentChoice[] };
  return Array.isArray(body.agents) ? body.agents : [];
}

/**
 * How a connection's choice reads beside it: "Everything" for none, else the
 * configuration's file name without its extension (the stored record is the
 * path; the name its definition carries is the distribution's to show).
 */
export function connectedAsLabel(agentPath: string | null | undefined): string {
  if (!agentPath) return 'Everything';
  const base = agentPath.slice(agentPath.lastIndexOf('/') + 1);
  return base.replace(/\.[a-z0-9]+$/i, '') || agentPath;
}
