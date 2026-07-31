import express from 'express';
import type { IAdminAccessService } from './admin.interface.js';
import '../auth/auth.middleware.js'; // Express Request augmentation

/**
 * The CORE slice of the admin surface: just the admin-status resolver the
 * frontend branches on (AdminMenu's "Admin only" section, the roles-recovery
 * banner). The full admin router (feedback inbox, user administration /
 * GDPR erasure) is an enterprise extension mounted via
 * `ServerExtensions.authed`.
 *
 * NOTE (core split): in bevel-platform this endpoint lives in the enterprise
 * `admin.routes.ts`; core serves it itself so a core-only deployment can
 * resolve admin status. Express keeps first-match-wins, so an enterprise
 * overlay's own `/admin/access` (mounted later) never shadows this one —
 * both resolve through the same {@link IAdminAccessService}.
 */
export function createAdminAccessRoutes(adminAccess: IAdminAccessService): express.Router {
  const router = express.Router();

  // Open to any authenticated user — returns `false` for non-admins instead of
  // 403 so the frontend can branch on the answer without treating a normal
  // user as an error case.
  router.get('/admin/access', async (req, res) => {
    res.json({ isAdmin: await adminAccess.isAdmin(req.userEmail) });
  });

  return router;
}
