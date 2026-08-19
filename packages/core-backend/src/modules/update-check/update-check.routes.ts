import express from 'express';
import type { IAdminAccessService } from '../admin/admin.interface.js';
import type { UpdateCheckService } from './update-check.service.js';
import '../auth/auth.middleware.js'; // Express Request augmentation

/**
 * `GET /api/update-check` — ADMIN-ONLY (same `requireAdmin` shape as the setup
 * routes): admins are the audience of the banner and the only ones who can act
 * on it, and there is no reason to narrate the deployment's patch level to
 * everyone else. The service behind it does the caching, so this is safe to
 * call as often as the frontend likes.
 */
export function createUpdateCheckRoutes(
  service: Pick<UpdateCheckService, 'check'>,
  adminAccess: IAdminAccessService,
): express.Router {
  const router = express.Router();

  router.get('/update-check', async (req, res) => {
    if (!(await adminAccess.isAdmin(req.userEmail))) {
      res.status(403).json({ error: 'Admins only' });
      return;
    }
    res.json(await service.check());
  });

  return router;
}
