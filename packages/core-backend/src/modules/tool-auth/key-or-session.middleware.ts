import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * One gate for an endpoint that serves the app AND agents: a bearer that
 * looks like a tool credential (a `bevel_…` connection key, an internal
 * token) goes through the tool-auth middleware; anything else — the
 * browser's session JWT, its cookie — goes through the session middleware.
 * Whichever admitted the caller, `req.userId` names them afterwards, so a
 * handler written for sessions (`resolveUser` → `req.userId`) serves both.
 *
 * Composition, not a third verifier: each credential is still checked by
 * the code that owns it. Deliberately NOT the read-only-manuals gate
 * (`createManualAuthMiddleware`), which is documented as the one place a
 * session may stand in for a tool credential; here it is the other way
 * round — a tool credential is admitted to an app endpoint — and only for
 * endpoints a tool definition describes.
 */
export function keyOrSessionAuth(deps: {
  sessionAuth: RequestHandler;
  toolAuth: RequestHandler;
  /** Whether a bearer value is a tool credential rather than a session token. */
  isToolCredential(token: string): boolean;
}): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    const token =
      header && header.toLowerCase().startsWith('bearer ') ? header.slice(header.indexOf(' ') + 1).trim() : '';
    if (!token || !deps.isToolCredential(token)) {
      deps.sessionAuth(req, res, next);
      return;
    }
    deps.toolAuth(req, res, (err?: unknown) => {
      if (err) {
        next(err);
        return;
      }
      // The tool gate names the caller on `req.toolAuth`; the endpoint reads
      // `req.userId`, as it does for a session.
      if (req.toolAuth && !req.userId) req.userId = req.toolAuth.userId;
      next();
    });
  };
}
