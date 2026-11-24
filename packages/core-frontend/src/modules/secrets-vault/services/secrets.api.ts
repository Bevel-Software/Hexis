import { authFetch } from '../../../lib/api';
import { secretsPath, type ActingFor } from './acting-for';

export type SecretKind = 'static' | 'oauth';

/** A stored secret as shown in the UI — never carries the value/token material. */
export interface SecretSummary {
  id: string;
  key: string;
  kind: SecretKind;
  label: string | null;
  /** For `oauth`: whether the user has completed the authorization flow. */
  authorized?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface OAuthProviderConfig {
  authorizationUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret?: string;
  scopes?: string[];
  /** Extra static params appended to the authorization request (e.g. `audience`). */
  authParams?: Record<string, string>;
  /** PKCE (S256) on the authorization-code flow — what MCP-spec providers require. */
  pkce?: boolean;
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

/** `bot`: whose secrets (see `acting-for.ts`); null, the default, is the person's. */
export async function listSecrets(bot: ActingFor = null): Promise<SecretSummary[]> {
  const res = await authFetch(secretsPath('/api/secrets', bot));
  if (!res.ok) await unwrap(res, "Couldn't load your secrets.");
  return ((await res.json()) as { secrets: SecretSummary[] }).secrets;
}

export async function putStaticSecret(input: {
  key: string;
  value: string;
  label?: string | null;
}, bot: ActingFor = null): Promise<SecretSummary> {
  const res = await authFetch(secretsPath('/api/secrets/static', bot), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) await unwrap(res, "Couldn't save this secret.");
  return ((await res.json()) as { secret: SecretSummary }).secret;
}

export async function createOAuthSecret(input: {
  key: string;
  label?: string | null;
  provider: OAuthProviderConfig;
}, bot: ActingFor = null): Promise<SecretSummary> {
  const res = await authFetch(secretsPath('/api/secrets/oauth', bot), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) await unwrap(res, "Couldn't save this OAuth secret.");
  return ((await res.json()) as { secret: SecretSummary }).secret;
}

export async function deleteSecret(id: string, bot: ActingFor = null): Promise<void> {
  const res = await authFetch(secretsPath(`/api/secrets/${encodeURIComponent(id)}`, bot), { method: 'DELETE' });
  if (!res.ok && res.status !== 204) await unwrap(res, "Couldn't remove this secret.");
}

/** Fetch the provider consent URL for an oauth secret; the caller navigates to it. */
export async function startOAuth(id: string, bot: ActingFor = null): Promise<string> {
  const res = await authFetch(secretsPath(`/api/secrets/${encodeURIComponent(id)}/oauth/start`, bot));
  if (!res.ok) await unwrap(res, "Couldn't start authorization.");
  return ((await res.json()) as { url: string }).url;
}
