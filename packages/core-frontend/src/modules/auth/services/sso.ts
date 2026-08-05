/**
 * SSO client helpers, provider-agnostic: the login screen renders one button
 * per provider advertised by the backend's capability probe (the generic OIDC
 * plugin, the enterprise "Sign in with Microsoft", …).
 *
 * Every provider flow is a full-page redirect (not fetch): the button sends
 * the browser to the provider's `startPath` on the backend, which bounces to
 * the identity provider and back to `/auth/<key>/callback#token=…` (or
 * `#error=…`). We read the JWT out of the URL fragment — fragments aren't
 * sent to servers or stored in Referer/logs.
 */

/** Matches every provider's frontend callback path (`/auth/<key>/callback`). */
const CALLBACK_PATH_RE = /^\/auth\/[a-z0-9-]+\/callback$/;

/** Set when a callback carried an error, read once by the login screen. */
export const OAUTH_ERROR_KEY = 'bevel_oauth_error';

/** One SSO login method, as advertised by `GET /api/auth/providers`. */
export interface SsoProvider {
  key: string;
  label: string;
  startPath: string;
}

/** Which login methods this deployment offers. */
export interface LoginProviders {
  password: boolean;
  sso: SsoProvider[];
}

/** Kick off a provider's OAuth round-trip. */
export function startSsoLogin(provider: SsoProvider): void {
  window.location.href = provider.startPath;
}

/**
 * Probe which login methods are enabled. On failure default to password-only
 * so a transient error never hides the only working method (and never
 * surfaces an SSO button the backend can't service).
 */
export async function fetchLoginProviders(): Promise<LoginProviders> {
  try {
    const res = await fetch('/api/auth/providers');
    if (!res.ok) return { password: true, sso: [] };
    const body = (await res.json()) as Partial<LoginProviders>;
    return {
      password: body.password !== false,
      sso: Array.isArray(body.sso) ? body.sso : [],
    };
  } catch {
    return { password: true, sso: [] };
  }
}

/**
 * If the current page is any provider's OAuth callback, extract the
 * token/error from the fragment and scrub the URL (so the token never lingers
 * in the address bar or browser history). Returns {} when not on a callback
 * path.
 */
export function consumeSsoCallback(): { token?: string; error?: string } {
  if (!CALLBACK_PATH_RE.test(window.location.pathname)) return {};
  const raw = window.location.hash.startsWith('#')
    ? window.location.hash.slice(1)
    : window.location.hash;
  const params = new URLSearchParams(raw);
  const token = params.get('token') ?? undefined;
  const error = params.get('error') ?? undefined;
  // Replace the callback URL with the app root so a reload doesn't re-process it.
  window.history.replaceState({}, '', '/');
  return { token, error };
}
