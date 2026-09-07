import express from 'express';
import '../../auth/auth.middleware.js'; // Express Request.userId / userEmail augmentation
import {
  ClaudeBridgeUnavailableError,
  type ClaudeBridgeCredentialsService,
} from './claude-bridge-credentials.service.js';

export interface ClaudeBridgeAdminRoutesDeps {
  credentials: ClaudeBridgeCredentialsService;
  isAdmin(email: string | undefined): Promise<boolean>;
  /** The hostname Claude registers — the deployment's public host. */
  publicUrl: string;
  /** The marketplace URL people paste — the same one Claude Code clones. */
  marketplaceUrl: string;
}

/**
 * What an Owner needs to register this deployment in Claude's admin settings
 * as a GitHub Enterprise Server, in the fields that form has — and the one
 * verb on it, rotate. Admins only: the client secret is what makes claude.ai
 * trust the token exchange.
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
    const host = new URL(deps.publicUrl).host;
    return {
      host,
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

  router.get('/admin/claude-bridge', requireAdmin, async (_req, res) => {
    try {
      res.json(await describe());
    } catch (err) {
      answer(res, err);
    }
  });

  router.post('/admin/claude-bridge/rotate', requireAdmin, async (_req, res) => {
    try {
      await deps.credentials.rotate();
      res.json(await describe());
    } catch (err) {
      answer(res, err);
    }
  });

  return router;
}

function answer(res: express.Response, err: unknown): void {
  if (err instanceof ClaudeBridgeUnavailableError) {
    res.status(409).json({ error: err.message });
    return;
  }
  console.error('[claude-bridge admin]', err);
  res.status(500).json({ error: 'Internal error' });
}
