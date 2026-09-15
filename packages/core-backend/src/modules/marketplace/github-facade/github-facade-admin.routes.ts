import express from 'express';
import '../../auth/auth.middleware.js'; // Express Request.userId / userEmail augmentation
import {
  GitHubFacadeUnavailableError,
  type GitHubFacadeCredentialsService,
} from './github-facade-credentials.service.js';

export interface GitHubFacadeAdminRoutesDeps {
  credentials: GitHubFacadeCredentialsService;
  isAdmin(email: string | undefined): Promise<boolean>;
  /** The deployment's public address; only its host is shown. */
  publicUrl: string;
  /** The marketplace URL people paste — the same one Claude Code clones. */
  marketplaceUrl: string;
}

/**
 * What an Owner needs to register this deployment in Claude's admin settings
 * as a GitHub Enterprise Server, in the fields that form has — and the one
 * verb on it, rotate. Admins only: the client secret is what makes claude.ai
 * trust the token exchange. Never cached: after a rotation or a sign-out no
 * copy of the old secrets may linger in a browser or a proxy.
 *
 *   GET  /api/admin/github-facade               the credentials and the two URLs
 *   POST /api/admin/github-facade/rotate        new credentials, all of them
 *   PUT  /api/admin/github-facade/registration  `{ registered }` — an admin says so
 *
 * And one read that is NOT admin-only, because the External agent access page
 * shows every signed-in person either the tutorial or "an admin has to set
 * this up first":
 *
 *   GET  /api/github-facade/registration        `{ registered: boolean }`, nothing else
 *
 * That answer is built from a boolean, never from the credentials object, so
 * no future field on the credentials can ride along into it.
 */
export function createGitHubFacadeAdminRoutes(deps: GitHubFacadeAdminRoutesDeps): express.Router {
  const router = express.Router();

  const requireAdmin: express.RequestHandler = async (req, res, next) => {
    if (!(await deps.isAdmin(req.userEmail))) {
      res.status(403).json({ error: 'Admins only' });
      return;
    }
    next();
  };

  const describe = async () => {
    const creds = await deps.credentials.ensure();
    return {
      host: new URL(deps.publicUrl).host,
      appId: creds.appId,
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      webhookSecret: creds.webhookSecret,
      privateKeyPem: creds.privateKeyPem,
      marketplaceUrl: deps.marketplaceUrl,
      createdAt: creds.createdAt.getTime(),
      rotatedAt: creds.rotatedAt ? creds.rotatedAt.getTime() : null,
    };
  };

  const send = async (res: express.Response, body: () => Promise<unknown>) => {
    try {
      const payload = await body();
      res.setHeader('Cache-Control', 'no-store');
      res.json(payload);
    } catch (err) {
      if (err instanceof GitHubFacadeUnavailableError) {
        res.status(409).json({ error: err.message });
        return;
      }
      console.error('[github-facade admin]', err);
      res.status(500).json({ error: 'Internal error' });
    }
  };

  router.get('/admin/github-facade', requireAdmin, (_req, res) => send(res, describe));

  router.post('/admin/github-facade/rotate', requireAdmin, (_req, res) =>
    send(res, async () => {
      await deps.credentials.rotate();
      return describe();
    }),
  );

  router.get('/github-facade/registration', (req, res) => {
    // Mounted behind the session middleware; this is belt and braces for a
    // mount that forgets it — anonymous callers learn nothing.
    if (!req.userId) {
      res.status(401).json({ error: 'Sign in first' });
      return;
    }
    return send(res, async () => ({ registered: await deps.credentials.isRegistered() }));
  });

  router.put('/admin/github-facade/registration', requireAdmin, (req, res) => {
    const registered = (req.body as { registered?: unknown } | undefined)?.registered;
    if (typeof registered !== 'boolean') {
      res.status(400).json({ error: '`registered` must be true or false' });
      return;
    }
    return send(res, async () => ({ registered: await deps.credentials.setRegistered(registered) }));
  });

  return router;
}
