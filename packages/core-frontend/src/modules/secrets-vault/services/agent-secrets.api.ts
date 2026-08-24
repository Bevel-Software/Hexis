import { authFetch } from '../../../lib/api';

/**
 * Per-agent secrets API. An `.agent` file declares the environment an execution
 * layer injects into a session process; its `from: vault` entries are secrets
 * and are provisioned here.
 *
 * Unlike a tool variable, there is no per-user tier: an agent is run by an
 * execution layer under its own service identity, so one shared value is the
 * only value anything reads. Whoever may edit the `.agent` file may set what it
 * is given — the people who decide what an agent asks for are the people who
 * decide what it gets.
 */

export interface AgentVarStatus {
  /** Bare variable name as the session process will see it (e.g. `OPENAI_API_KEY`). */
  name: string;
  label: string | null;
  /** The stored key — `agent:<slug>:<VAR>`. */
  key: string;
  /** A value exists. */
  configured: boolean;
}

export interface AgentSecrets {
  slug: string;
  name: string;
  path: string;
  description: string | null;
  /** Whether the caller may set this agent's secrets (write access to the `.agent`). */
  canWrite: boolean;
  variables: AgentVarStatus[];
}

async function unwrap(res: Response, fallback: string): Promise<never> {
  let message = fallback;
  try {
    const body = (await res.json()) as { error?: string };
    if (body?.error) message = body.error;
  } catch {
    // non-JSON body — keep the fallback
  }
  throw new Error(message);
}

/** Accessible agents that declare at least one vault variable; `path` narrows to one. */
export async function listAgentSecrets(path?: string): Promise<AgentSecrets[]> {
  const q = path ? `?path=${encodeURIComponent(path)}` : '';
  const res = await authFetch(`/api/secrets/agents${q}`);
  if (!res.ok) await unwrap(res, "Couldn't load agent secrets.");
  return ((await res.json()) as { agents: AgentSecrets[] }).agents;
}

const varPath = (slug: string, varName: string) =>
  `/api/secrets/agents/${encodeURIComponent(slug)}/vars/${encodeURIComponent(varName)}`;

export async function setAgentVar(slug: string, varName: string, value: string): Promise<void> {
  const res = await authFetch(varPath(slug, varName), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value }),
  });
  if (!res.ok) await unwrap(res, "Couldn't save this secret.");
}

export async function deleteAgentVar(slug: string, varName: string): Promise<void> {
  const res = await authFetch(varPath(slug, varName), { method: 'DELETE' });
  if (!res.ok && res.status !== 204) await unwrap(res, "Couldn't remove this secret.");
}
