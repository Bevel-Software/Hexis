import express from 'express';
import type { AuthService } from './auth.service.js';
import type { IAdminAccessService } from '../admin/admin.interface.js';
import './auth.middleware.js'; // Express Request augmentation

/**
 * Admin account management (Roles & Members → Accounts): list accounts and
 * create/reset password accounts. Gated per request by
 * {@link IAdminAccessService} — the Admin role in `roles.yaml`, plus the env
 * bootstrap admin (always-admin, see AdminAccessService).
 *
 * Deliberately namespaced `/admin/accounts` (not `/admin/users`): the
 * enterprise overlay mounts its own richer user administration (listing with
 * activity, GDPR erasure) at `/admin/users`, and the two must not shadow each
 * other across mount phases.
 */
export function createAccountRoutes(
  authService: AuthService,
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

  // GET /api/admin/accounts — id, email, name, whether a password is set.
  router.get('/admin/accounts', requireAdmin, async (_req, res) => {
    res.json({ accounts: await authService.listAccounts() });
  });

  // POST /api/admin/accounts { email, name?, password } — create an account
  // (or reset the password of an existing one; upsert-by-email is deliberate,
  // see AuthService.createAccount).
  router.post('/admin/accounts', requireAdmin, async (req, res) => {
    const { email, name, password } = req.body as {
      email?: string;
      name?: string;
      password?: string;
    };
    if (!email || !password) {
      res.status(400).json({ error: 'email and password are required' });
      return;
    }
    try {
      const user = await authService.createAccount(email, name, password);
      res.status(201).json(user);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      res.status(400).json({ error: msg });
    }
  });

  return router;
}
