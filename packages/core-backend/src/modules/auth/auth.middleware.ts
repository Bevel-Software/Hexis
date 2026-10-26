import type { Request, Response, NextFunction } from 'express';
import type { AuthService } from './auth.service.js';
import { AccountDeactivatedError, AuthBackendError, SessionEndedError } from './account-admission.js';

// Augment Express Request so userId/userEmail are available after auth middleware
declare global {
  namespace Express {
    interface Request {
      userId?: string;
      userEmail?: string;
    }
  }
}

/**
 * Name of the auth cookie set alongside the Bearer JWT at login. The cookie
 * exists solely so the SSE route can authenticate — the browser's
 * `EventSource` API can't set custom headers, so a Bearer token in
 * `Authorization` can't reach it. All other routes still use the Bearer
 * header, which the frontend stores in memory and attaches via `authFetch`.
 *
 * Same JWT value as the Bearer token. The cookie is `HttpOnly` + `SameSite=Lax`
 * + `Secure` when the deployment is reached over https — {@link setAuthCookie}
 * is its one issue site, for every sign-in path and the password change.
 */
export const AUTH_COOKIE_NAME = 'bevel_token';

/**
 * Max age of the JWT cookie (seconds). Matches the JWT's own `expiresIn:
 * '7d'` so the cookie expires when the token does — browsers stop
 * sending it past expiry, sparing the auth middleware verifying tokens
 * that are guaranteed to fail.
 */
export const AUTH_COOKIE_MAX_AGE_S = 7 * 24 * 60 * 60;

/**
 * Whether the auth cookie is marked `Secure`, from the scheme the deployment
 * is reached on: a browser never sends a `Secure` cookie over plain http, so
 * deriving it from `NODE_ENV` left a production deployment served over http
 * (a private network, a proxy that terminates nothing) without SSE and
 * images. One rule, asked by the composition root for every path that sets
 * the cookie.
 */
export function authCookieSecure(publicUrl: string): boolean {
  return publicUrl.startsWith('https');
}

/**
 * Set the JWT as the HttpOnly auth cookie so transports that can't carry
 * headers (EventSource for SSE, image tags) authenticate automatically. JSON
 * callers continue to use the Bearer header returned in the body. The one
 * place the cookie's attributes are spelled: password login, the password
 * change and every SSO provider set it through here.
 */
export function setAuthCookie(res: Response, token: string, secure: boolean): void {
  res.cookie(AUTH_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    maxAge: AUTH_COOKIE_MAX_AGE_S * 1000,
    path: '/',
  });
}

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

export function createAuthMiddleware(authService: Pick<AuthService, 'resolveSession'>) {
  return async (req: Request, res: Response, next: NextFunction) => {
    // Bearer is the primary path — every JSON API call in the frontend
    // attaches it via `authFetch`. Cookie is the fallback for transports
    // that can't carry headers (EventSource, image tags), set at login by
    // `/auth/login` so SSE in particular Just Works after login without
    // any frontend cooperation.
    const header = req.headers.authorization;
    let token: string | null = null;
    if (header && header.startsWith('Bearer ')) {
      token = header.slice('Bearer '.length).trim() || null;
    }
    if (!token) {
      token = readAuthCookie(req);
    }
    if (!token) {
      res.status(401).json({ error: 'Missing or invalid Authorization header or auth cookie' });
      return;
    }

    let session: { userId: string; email: string };
    try {
      session = await authService.resolveSession(token);
    } catch (err) {
      // The account could not be looked up: not the caller's doing, and a
      // 401 here would sign every valid session out during an outage.
      if (err instanceof AuthBackendError) {
        res.status(500).json({ error: 'Authentication backend unavailable' });
        return;
      }
      // A 401 otherwise, so the app drops the session and shows the login
      // page; a switched-off account, and a session a password change
      // ended, are told why there.
      const worded = err instanceof AccountDeactivatedError || err instanceof SessionEndedError;
      res.status(401).json({ error: worded ? err.message : 'Invalid or expired token' });
      return;
    }
    req.userId = session.userId;
    req.userEmail = session.email;
    next();
  };
}
