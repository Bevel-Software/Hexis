import type { Request } from 'express';

/**
 * How a request says who it is from: auth's cookie and the one rule for
 * reading a session token off a request. A leaf, so the session middleware
 * and a route mounted before it read a request the same way.
 */

/**
 * Name of the auth cookie set alongside the Bearer JWT at login. The cookie
 * exists solely so the SSE route can authenticate — the browser's
 * `EventSource` API can't set custom headers, so a Bearer token in
 * `Authorization` can't reach it. All other routes still use the Bearer
 * header, which the frontend stores in memory and attaches via `authFetch`.
 *
 * Same JWT value as the Bearer token. The cookie is `HttpOnly` + `SameSite=Lax`
 * + `Secure` when the deployment is reached over https — `setAuthCookie`
 * (`auth.middleware.ts`) is its one issue site, for every sign-in path and the password change.
 */
export const AUTH_COOKIE_NAME = 'bevel_token';

/**
 * Read the auth cookie out of the raw `Cookie` header without pulling in
 * `cookie-parser`. We only ever look for one cookie, so a tiny parser
 * beats the dep surface of a middleware. Returns `null` if the cookie
 * is absent or empty.
 */
export function readAuthCookie(req: Request): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const segment of header.split(';')) {
    const trimmed = segment.trim();
    if (!trimmed.startsWith(`${AUTH_COOKIE_NAME}=`)) continue;
    const value = trimmed.slice(AUTH_COOKIE_NAME.length + 1);
    if (!value) return null;
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return null;
}

/**
 * The session token a request carries: its `Authorization: Bearer` header,
 * else auth's cookie, else `null`. The rule the session middleware reads
 * every request by, offered on auth's entry for a route a deployment mounts
 * BEFORE that middleware (a download link clicked in a chat app arrives with
 * only the cookie), so it reads the token exactly as the middleware would and
 * resolves it through the auth service itself. It says nothing about whether
 * the token is a valid session.
 */
export function sessionTokenOf(req: Request): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    const bearer = header.slice('Bearer '.length).trim();
    if (bearer) return bearer;
  }
  return readAuthCookie(req);
}
