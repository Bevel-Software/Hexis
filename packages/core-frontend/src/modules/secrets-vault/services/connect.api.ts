import { authFetch } from '../../../lib/api';

/**
 * The aggregated "connect your tools" surface: everything the signed-in person
 * still needs to provide before the tools they can reach will work in their own
 * agent. It lists ONLY per-user items (never the admin/shared ones), split into
 * plain values (API keys) they enter and OAuth sign-ins they authorize.
 */

export interface ConnectVar {
  /** Bare variable name (e.g. `API_KEY`). */
  name: string;
  label: string | null;
  /** The stored key — `<manual>_<VAR>`. */
  key: string;
  /** The caller's own value exists. */
  configured: boolean;
}

export interface ConnectTool {
  slug: string;
  name: string;
  path: string;
  type: 'inline' | 'http' | 'mcp';
  variables: ConnectVar[];
}

export interface ConnectOAuth {
  id: string;
  key: string;
  label: string | null;
  authorized: boolean;
}

/** An OAuth-backed variable declared BY a tool — authorized via the tool-scoped start. */
export interface ConnectToolOAuth {
  slug: string;
  varName: string;
  toolName: string;
  key: string;
  label: string | null;
  authorized: boolean;
  /**
   * Authorized, but the token's granted permissions no longer cover what the tool
   * declares now (a scope was added since sign-in) — show Reconnect, not Connected.
   */
  needsReauth: boolean;
}

export interface ConnectPending {
  tools: ConnectTool[];
  oauth: ConnectOAuth[];
  toolOAuth: ConnectToolOAuth[];
}

/** Throw the response's `{ error }` message, or `fallback` for a non-JSON body. */
async function fail(res: Response, fallback: string): Promise<never> {
  let message = fallback;
  try {
    const body = (await res.json()) as { error?: string };
    if (body?.error) message = body.error;
  } catch {
    // non-JSON body — keep the fallback
  }
  throw new Error(message);
}

/** The caller's outstanding per-user credentials across every accessible tool. */
export async function getConnectPending(): Promise<ConnectPending> {
  const res = await authFetch('/api/connect/pending');
  if (!res.ok) await fail(res, "Couldn't load your tools.");
  return (await res.json()) as ConnectPending;
}

/**
 * Start a tool-scoped OAuth sign-in for one of a tool's OAuth-backed variables.
 *
 * `returnTo` is where the provider round-trip should deposit the browser — a
 * same-origin PATH, signed into the OAuth state server-side and re-validated at
 * the callback, so it cannot be turned into an open redirect. Pass the BARE
 * path: the validator rejects `#`, and the callback appends `#authorized=…` /
 * `#error=…` itself.
 *
 * The body is sent ONLY when a `returnTo` is given, which is what keeps the
 * `/connect` call sites byte-identical to their pre-`returnTo` behavior (no
 * body ⇒ the server's legacy `'connect'` destination).
 */
export async function startToolOAuth(
  slug: string,
  varName: string,
  opts?: { returnTo?: string },
): Promise<string> {
  const init: RequestInit = { method: 'POST' };
  if (opts?.returnTo) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify({ returnTo: opts.returnTo });
  }
  const res = await authFetch(
    `/api/secrets/tools/${encodeURIComponent(slug)}/vars/${encodeURIComponent(varName)}/oauth/start`,
    init,
  );
  if (!res.ok) await fail(res, "Couldn't start sign-in.");
  return ((await res.json()) as { url: string }).url;
}

// ---- MCP OAuth (an external agent connecting via our authorization server) ----

export interface McpOAuthRequest {
  /** The connecting MCP client's self-declared display name (e.g. "Claude"). */
  clientName: string | null;
  scope: string | null;
  resource: string | null;
}

/** Describe the pending MCP authorization carried in the signed `state`. */
export async function getMcpOAuthRequest(state: string): Promise<McpOAuthRequest> {
  const res = await authFetch(`/api/mcp/oauth/request?state=${encodeURIComponent(state)}`);
  if (!res.ok) await fail(res, "Couldn't load the connection request.");
  return (await res.json()) as McpOAuthRequest;
}

/**
 * Finish the MCP authorization: mint the one-time code for the signed-in user
 * and return the agent's redirect URL the browser should navigate to.
 */
export async function completeMcpOAuth(state: string): Promise<string> {
  const res = await authFetch('/api/mcp/oauth/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state }),
  });
  if (!res.ok) await fail(res, "Couldn't finish connecting.");
  return ((await res.json()) as { redirectTo: string }).redirectTo;
}
