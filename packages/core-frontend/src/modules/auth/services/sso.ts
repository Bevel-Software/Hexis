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

/**
 * Where a deep link waits out the SSO round-trip. Session storage, not the
 * OAuth `state` param: the backend never needs to see it, and per-tab scoping
 * with same-tab retrieval is exactly the lifetime a "put me back where I was
 * going" note should have.
 */
export const POST_LOGIN_REDIRECT_KEY = 'bevel_post_login_redirect';

/**
 * Kick off a provider's OAuth round-trip.
 *
 * The redirect leaves the page entirely, and with it the URL the person was
 * trying to open — password login keeps it (no navigation happens), but SSO
 * comes back to a fixed `/auth/<key>/callback` and the deep link someone
 * clicked in Slack would die in the round-trip. Stash it here; the far side
 * (`RootLanding`) puts them back — after the first-visit welcome, if this is
 * the one sign-in that shows it.
 */
export function startSsoLogin(provider: SsoProvider): void {
  const { pathname, search, hash } = window.location;
  try {
    if (pathname !== '/' && !pathname.startsWith('/auth/')) {
      sessionStorage.setItem(POST_LOGIN_REDIRECT_KEY, `${pathname}${search}${hash}`);
    } else {
      // A plain front-door sign-in must not inherit a stale note from an
      // earlier round-trip in this tab.
      sessionStorage.removeItem(POST_LOGIN_REDIRECT_KEY);
    }
  } catch {
    // Storage denied (private mode, policy) — the deep link just won't
    // survive the round-trip, which is where we started.
  }
  window.location.href = provider.startPath;
}

/**
 * The stashed deep link, taken (read-and-cleared). Only ever an in-app path:
 * anything not starting with a single `/` is discarded, so nothing that ends
 * up in storage can turn the post-login hop into an off-site redirect.
 */
export function takePostLoginRedirect(): string | null {
  try {
    const raw = sessionStorage.getItem(POST_LOGIN_REDIRECT_KEY);
    if (raw !== null) sessionStorage.removeItem(POST_LOGIN_REDIRECT_KEY);
    if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return null;
    return raw;
  } catch {
    return null;
  }
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
