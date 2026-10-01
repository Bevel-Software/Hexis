import type { Request, Response, NextFunction } from 'express';
import type { AuthService } from './auth.service.js';
import { AccountDeactivatedError } from './account-admission.js';

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
 * + `Secure` (in prod) — see `auth.routes.ts` for the issue site.
 */
export const AUTH_COOKIE_NAME = 'bevel_token';

/**
 * Read the auth cookie out of the raw `Cookie` header without pulling in
 * `cookie-parser`. We only ever look for one cookie, so a tiny parser
 * beats the dep surface of a middleware. Returns `null` if the cookie
 * is absent or empty.
 */
function readAuthCookie(req: Request): string | null {
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
      // A 401 either way, so the app drops the session and shows the login
      // page; a switched-off account is told why there.
      res.status(401).json({ error: err instanceof AccountDeactivatedError ? err.message : 'Invalid or expired token' });
      return;
    }
    req.userId = session.userId;
    req.userEmail = session.email;
    next();
  };
}
