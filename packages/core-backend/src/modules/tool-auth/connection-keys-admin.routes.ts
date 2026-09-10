import express from 'express';
import type { IAdminAccessService } from '../admin/admin.interface.js';
import { TokenNotFoundError } from './external-api-key.errors.js';
import type { IExternalApiKeyService } from './external-api-key.interface.js';
import '../auth/auth.middleware.js'; // Express Request augmentation

/** Shape of the `api_tokens.id` column (any uuid version; case-insensitive). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Admin overview of connection keys across the deployment (the core
 * "Connection keys" admin page): every key on every account — owner, label,
 * created, last used, whether it is still live — and a revoke that is not
 * scoped to the caller. The per-user surface stays in mcp.routes.ts; this
 * router exists so an admin can cut off a leaked or forgotten key without
 * signing in as its owner. Gated per request by {@link IAdminAccessService}.
 */
export function createConnectionKeysAdminRoutes(
  externalApiKeyService: Pick<IExternalApiKeyService, 'listForDeployment' | 'revokeAny'>,
  adminAccess: IAdminAccessService,
): express.Router {
  const router = express.Router();

  const requireAdmin: express.RequestHandler = async (req, res, next) => {
    if (!(await adminAccess.isAdmin(req.userEmail))) {
      res.status(403).json({ error: 'Admins only' });
      return;
    }
    next();
  };

  // GET /api/admin/connection-keys — every key with its owner, ordered by
  // owner email then newest-first. Never carries a plaintext or a hash.
  router.get('/admin/connection-keys', requireAdmin, async (_req, res) => {
    try {
      res.json({ keys: await externalApiKeyService.listForDeployment() });
    } catch (err) {
      console.error('[connection-keys] admin list failed:', err);
      res.status(500).json({ error: 'Failed to load connection keys' });
    }
  });

  // DELETE /api/admin/connection-keys/:id — revoke a key
  // belonging to ANY account. Idempotent on an already-revoked key; 404 when
  // no such key exists. Revoked rows are kept so `last_used_at` stays
  // auditable after a leak — there is deliberately no admin hard-delete.
  router.delete('/admin/connection-keys/:id', requireAdmin, async (req, res) => {
    const id = String(req.params.id);
    // The id column is a uuid: anything else makes Postgres raise a cast
    // error before the WHERE is even evaluated, which would surface as a 500.
    // A malformed id names no key, so it is a not-found, same as an unknown one.
    if (!UUID_RE.test(id)) {
      res.status(404).json({ error: 'Token not found' });
      return;
    }
    try {
      await externalApiKeyService.revokeAny(id);
      // Accountability record: WHO revoked WHICH key. Ids only — the key's
      // label is the owner's free text and does not belong in logs.
      console.log(
        '[connection-keys] revoke audit:',
        JSON.stringify({ action: 'admin-revoke-key', actorUserId: req.userId, tokenId: id }),
      );
      res.json({ status: 'revoked' });
    } catch (err) {
      if (err instanceof TokenNotFoundError) {
        res.status(404).json({ error: err.message });
        return;
      }
      console.error('[connection-keys] admin revoke failed:', err);
      res.status(500).json({ error: 'Failed to revoke this key' });
    }
  });

  return router;
}
