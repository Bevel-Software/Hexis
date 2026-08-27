import { authFetch } from '../../../lib/api';

/**
 * Per-tool secrets API. A `.tool` manual declares which `${VAR}`s are set by the
 * tool owner (`admin`, one shared value) vs by each end user (`user`). These
 * calls drive both the `.tool` editor sidebar and the Secrets page.
 */

export type ToolVarScope = 'admin' | 'user';

export interface ToolVarStatus {
  /** Bare variable name (e.g. `API_KEY`). */
  name: string;
  scope: ToolVarScope;
  label: string | null;
  /** The stored key — `<manual>_<VAR>`. */
  key: string;
  /** A shared (admin) value exists. */
  adminConfigured: boolean;
  /** The caller's own value exists. */
  userConfigured: boolean;
  /** This variable is filled by an OAuth sign-in, not a typed value. */
  oauth?: boolean;
  /** For an oauth var: the caller has completed sign-in (a token exists). */
  authorized?: boolean;
  /** For an oauth var: authorized, but the token doesn't cover all declared scopes. */
  needsReauth?: boolean;
  /** For an oauth var: the declared scopes the token was NOT granted (what it can't do). */
  missingScopes?: string[];
}

/**
 * For a `type: mcp` tool, the setup requirement auto-discovery found:
 *  - `open`         — no auth; nothing to configure.
 *  - `oauth-auto`   — sign-in was set up automatically (appears as a user var).
 *  - `oauth-manual` — the sign-in needs an OAuth app the owner registers with
 *                     the provider: a tool writer declares its client id on a
 *                     user-scoped variable (the server editor for an mcp.json
 *                     server; the `.tool` file otherwise) and sets its client
 *                     secret. `reason` is present only while something still
 *                     blocks the sign-in, and says what.
 */
export interface ToolSetup {
  kind: 'open' | 'oauth-auto' | 'oauth-manual';
  reason?: string;
}

/**
 * The verdict of the last credential PROBE — a different question from every
 * `ToolVarStatus` field, which say only what is STORED.
 *
 *  - `ok`           — the provider was called and accepted the credential.
 *  - `failed`       — the provider rejected it; `detail` is what it said.
 *  - `unverifiable` — we don't know: either the tool offers no way to test it,
 *                     or the attempt couldn't reach a verdict. `detail` says which.
 *
 * `null` on a tool that has never been probed, which the UI reads exactly like
 * `unverifiable` — "not checked yet" and "can't be checked" are both "we don't
 * know", and inventing a fourth badge for the difference would be noise.
 */
export interface ToolHealth {
  status: 'ok' | 'failed' | 'unverifiable';
  detail: string | null;
  checkedAt: string;
}

export interface ToolSecrets {
  slug: string;
  name: string;
  path: string;
  type: 'inline' | 'http' | 'mcp';
  /** MCP auto-discovery setup requirement; `null` for non-mcp tools. */
  setup: ToolSetup | null;
  /** Whether the caller may set this tool's admin (shared) secrets. */
  canWrite: boolean;
  variables: ToolVarStatus[];
  /** Last probe verdict; `null` when never probed. See {@link ToolHealth}. */
  health: ToolHealth | null;
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

/** All accessible tools with their variables + config status; `path` narrows to one tool. */
export async function listToolSecrets(path?: string): Promise<ToolSecrets[]> {
  const q = path ? `?path=${encodeURIComponent(path)}` : '';
  const res = await authFetch(`/api/secrets/tools${q}`);
  if (!res.ok) await unwrap(res, "Couldn't load tool secrets.");
  return ((await res.json()) as { tools: ToolSecrets[] }).tools;
}

const varPath = (slug: string, varName: string, tier: ToolVarScope) =>
  `/api/secrets/tools/${encodeURIComponent(slug)}/vars/${encodeURIComponent(varName)}/${tier}`;

async function putVar(slug: string, varName: string, tier: ToolVarScope, value: string, label?: string | null): Promise<void> {
  const res = await authFetch(varPath(slug, varName, tier), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value, label: label ?? null }),
  });
  if (!res.ok) await unwrap(res, "Couldn't save this secret.");
}

async function deleteVar(slug: string, varName: string, tier: ToolVarScope): Promise<void> {
  const res = await authFetch(varPath(slug, varName, tier), { method: 'DELETE' });
  if (!res.ok && res.status !== 204) await unwrap(res, "Couldn't remove this secret.");
}

/**
 * Store the confidential OAuth CLIENT SECRET for a tool's declared sign-in
 * provider — the owner-side half of a manual OAuth setup. Requires write access
 * to the `.tool`; the public provider config is pinned server-side from the
 * file's own `oauth` declaration.
 */
export async function setOAuthClientSecret(slug: string, varName: string, clientSecret: string): Promise<void> {
  const res = await authFetch(
    `/api/secrets/tools/${encodeURIComponent(slug)}/vars/${encodeURIComponent(varName)}/oauth/admin`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientSecret }),
    },
  );
  if (!res.ok) await unwrap(res, "Couldn't save the client secret.");
}

/**
 * Probe this tool's credential NOW and return the verdict.
 *
 * Called after saving a key so the user learns immediately whether it works,
 * while they still have it to hand — the moment a wrong key is cheapest to fix.
 * A rejected credential is a SUCCESSFUL check, so it resolves with
 * `status: 'failed'` rather than throwing; only a transport or access failure
 * rejects.
 */
export async function checkToolConnection(slug: string): Promise<ToolHealth> {
  const res = await authFetch(`/api/secrets/tools/${encodeURIComponent(slug)}/check`, { method: 'POST' });
  if (!res.ok) await unwrap(res, "Couldn't test this connection.");
  return ((await res.json()) as { health: ToolHealth }).health;
}

export const setAdminVar = (slug: string, varName: string, value: string, label?: string | null) =>
  putVar(slug, varName, 'admin', value, label);
export const setUserVar = (slug: string, varName: string, value: string, label?: string | null) =>
  putVar(slug, varName, 'user', value, label);
export const deleteAdminVar = (slug: string, varName: string) => deleteVar(slug, varName, 'admin');
export const deleteUserVar = (slug: string, varName: string) => deleteVar(slug, varName, 'user');
