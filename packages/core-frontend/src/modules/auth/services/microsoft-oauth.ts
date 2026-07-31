/**
 * "Sign in with Microsoft" client helpers.
 *
 * The flow is a full-page redirect (not fetch): the button sends the browser to
 * the backend, which bounces to Microsoft and back to
 * `/auth/microsoft/callback#token=…` (or `#error=…`). We read the JWT out of the
 * URL fragment — fragments aren't sent to servers or stored in Referer/logs.
 */

const CALLBACK_PATH = '/auth/microsoft/callback';
/** Set when the callback carried an error, read once by the login screen. */
export const OAUTH_ERROR_KEY = 'bevel_oauth_error';

/** Kick off the OAuth round-trip. */
export function startMicrosoftLogin(): void {
  window.location.href = '/api/auth/microsoft/login';
}

/** Which login methods this deployment offers. */
export interface LoginProviders {
  password: boolean;
  microsoft: boolean;
}

/**
 * Probe which login methods are enabled. On failure default to
 * password-only so a transient error never hides the only working method
 * (and never surfaces a Microsoft button the backend can't service).
 */
export async function fetchLoginProviders(): Promise<LoginProviders> {
  try {
    const res = await fetch('/api/auth/providers');
    if (!res.ok) return { password: true, microsoft: false };
    const body = (await res.json()) as Partial<LoginProviders>;
    return { password: body.password !== false, microsoft: !!body.microsoft };
  } catch {
    return { password: true, microsoft: false };
  }
}

/**
 * If the current page is the OAuth callback, extract the token/error from the
 * fragment and scrub the URL (so the token never lingers in the address bar or
 * browser history). Returns {} when not on the callback path.
 */
export function consumeMicrosoftCallback(): { token?: string; error?: string } {
  if (window.location.pathname !== CALLBACK_PATH) return {};
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
