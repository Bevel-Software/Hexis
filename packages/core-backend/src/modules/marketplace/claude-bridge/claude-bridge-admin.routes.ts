import express from 'express';
import '../../auth/auth.middleware.js'; // Express Request.userId / userEmail augmentation
import {
  ClaudeBridgeUnavailableError,
  type ClaudeBridgeCredentialsService,
} from './claude-bridge-credentials.service.js';

export interface ClaudeBridgeAdminRoutesDeps {
  credentials: ClaudeBridgeCredentialsService;
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
 *   GET  /api/admin/claude-bridge          the credentials and the two URLs
 *   POST /api/admin/claude-bridge/rotate   new credentials, all of them
 */
export function createClaudeBridgeAdminRoutes(deps: ClaudeBridgeAdminRoutesDeps): express.Router {
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
      if (err instanceof ClaudeBridgeUnavailableError) {
        res.status(409).json({ error: err.message });
        return;
      }
      console.error('[claude-bridge admin]', err);
      res.status(500).json({ error: 'Internal error' });
    }
  };

  router.get('/admin/claude-bridge', requireAdmin, (_req, res) => send(res, describe));

  router.post('/admin/claude-bridge/rotate', requireAdmin, (_req, res) =>
    send(res, async () => {
      await deps.credentials.rotate();
      return describe();
    }),
  );

  return router;
}
