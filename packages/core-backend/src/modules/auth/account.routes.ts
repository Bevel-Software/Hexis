import express from 'express';
import type { AuthService } from './auth.service.js';
import type { AccountErasureService } from './account-erasure.service.js';
import type { IAdminAccessService } from '../admin/admin.interface.js';
import './auth.middleware.js'; // Express Request augmentation

/**
 * Admin account management — the ONE account surface (the core User Accounts
 * page): list accounts, create/reset password accounts, and permanently
 * erase one (the GDPR Art. 17 path — hard-deletes the user's personal data
 * and anonymizes their audit rows; overlays contribute their slices via
 * {@link AccountErasureService}'s participants). Gated per request by
 * {@link IAdminAccessService} — the Admin role in `roles.yaml`, plus the env
 * bootstrap admin (always-admin, see AdminAccessService).
 */
export function createAccountRoutes(
  authService: AuthService,
  adminAccess: IAdminAccessService,
  accountErasure: AccountErasureService,
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

  // DELETE /api/admin/accounts/:userId — permanent erasure (moved from the
  // enterprise admin router with the split-repair: deleting accounts is core
  // platform functionality, not an enterprise extra).
  router.delete('/admin/accounts/:userId', requireAdmin, async (req, res) => {
    const userId = String(req.params.userId);
    // Self-erasure would delete the account authorizing the request mid-flight
    // (and can silently remove the deployment's only working admin login) —
    // require a second admin to do it.
    if (userId === req.userId) {
      res.status(400).json({ error: 'You cannot erase your own account. Ask another admin.' });
      return;
    }
    try {
      const erased = await accountErasure.eraseUser(userId);
      if (!erased) {
        res.status(404).json({ error: 'No such user' });
        return;
      }
      res.status(204).end();
    } catch (err) {
      console.error('[accounts] user erasure failed:', err);
      res.status(500).json({ error: 'Failed to erase user' });
    }
  });

  return router;
}
