import express from 'express';
import { randomUUID } from 'node:crypto';
import { logger } from '../../shared/logging.js';

const log = logger('accounts');
import type { AuthUser } from '@bevel-software/platform-shared';
import type { AuthService } from './auth.service.js';
import { erasedAccountId, type IAccountErasureService } from './account-erasure.service.js';
import type { IAdminAccessService } from '../admin/admin.interface.js';
import type { UserAccessRemovalService } from '../access/user-access-removal.service.js';
import { sendError } from '../access/admin-route-helpers.js';
import { WorkflowDomainError } from '../../shared/domain-errors.js';
import './auth.middleware.js'; // Express Request augmentation

/**
 * Admin account management — the ONE account surface (the core User Accounts
 * page): list accounts, create/reset password accounts, and permanently
 * erase one (the GDPR Art. 17 path — hard-deletes the user's personal data
 * and anonymizes their audit rows; overlays contribute their slices via
 * {@link AccountErasureService}'s participants), optionally removing the
 * address from roles, groups and access rules too
 * ({@link UserAccessRemovalService}). Gated per request by
 * {@link IAdminAccessService} — the Admin role in `roles.yaml`, plus the env
 * bootstrap admin (always-admin, see AdminAccessService).
 */
export function createAccountRoutes(
  authService: Pick<AuthService, 'listAccounts' | 'createAccount' | 'getUserById'>,
  adminAccess: IAdminAccessService,
  accountErasure: Pick<IAccountErasureService, 'eraseUser'>,
  accessRemoval?: Pick<UserAccessRemovalService, 'report' | 'assertRemovable' | 'remove' | 'filesNaming'>,
): express.Router {
  const router = express.Router();

  const requireAdmin: express.RequestHandler = async (req, res, next) => {
    if (!(await adminAccess.isAdmin(req.userEmail))) {
      res.status(403).json({ error: 'Admins only' });
      return;
    }
    next();
  };

  // GET /api/admin/accounts — id, email, name, whether a password hash is
  // stored, and whether the account is the env bootstrap admin.
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

  // GET /api/admin/accounts/:userId/references — how many places in the
  // knowledge base name this account's address (roles, groups, access rules,
  // file grants) and whether removing them is allowed. Feeds the delete
  // confirmation; the counts never include the address itself.
  router.get('/admin/accounts/:userId/references', requireAdmin, async (req, res) => {
    if (!accessRemoval) {
      res.status(404).json({ error: 'Not available' });
      return;
    }
    try {
      const user = await authService.getUserById(String(req.params.userId));
      if (!user) {
        res.status(404).json({ error: 'No such user' });
        return;
      }
      res.json(await accessRemoval.report(user.email));
    } catch (err) {
      sendError(res, err, 'accounts');
    }
  });

  // DELETE /api/admin/accounts/:userId[?removeFromAccess=1] — permanent
  // erasure (moved from the enterprise admin router with the split-repair:
  // deleting accounts is core platform functionality, not an enterprise
  // extra). With `removeFromAccess`, the address is also removed from
  // roles.yaml, group files and every access rule in ONE commit, AFTER the
  // erasure: a failed commit never un-deletes the account, it reports the
  // files that still name the user (200 + `accessRemoval`) so the admin can
  // fix them. Without it, the account is deleted as before (204).
  router.delete('/admin/accounts/:userId', requireAdmin, async (req, res) => {
    const userId = String(req.params.userId);
    // Self-erasure would delete the account authorizing the request mid-flight
    // (and can silently remove the deployment's only working admin login) —
    // require a second admin to do it.
    if (userId === req.userId) {
      res.status(400).json({ error: 'You cannot erase your own account. Ask another admin.' });
      return;
    }
    const flag = String(req.query.removeFromAccess ?? '');
    const removeFromAccess = accessRemoval !== undefined && (flag === '1' || flag === 'true');

    // Captured BEFORE erasure (the row is gone after) and held only in memory
    // for the removal below — never logged, never returned.
    let email: string | null = null;
    let actor: AuthUser | null = null;
    if (removeFromAccess) {
      try {
        const user = await authService.getUserById(userId);
        if (!user) {
          res.status(404).json({ error: 'No such user' });
          return;
        }
        email = user.email;
        // The existing guards: the deployment owner and the last Admin are
        // refused up front, before anything is erased.
        await accessRemoval!.assertRemovable(email);
        actor = (req.userId ? await authService.getUserById(req.userId) : null) ?? {
          id: req.userId ?? 'unknown',
          email: req.userEmail ?? 'unknown',
          name: req.userEmail ?? 'unknown',
        };
      } catch (err) {
        sendError(res, err, 'accounts');
        return;
      }
    }

    const erasureId = randomUUID();
    try {
      const erased = removeFromAccess
        ? await accountErasure.eraseUser(userId, { erasureId })
        : await accountErasure.eraseUser(userId);
      // Accountability record for the destructive path: WHO erased WHOM, by
      // id only — the target's email must not outlive the erasure in logs.
      log.info('erasure audit:', { action: 'erase-user', actorUserId: req.userId, targetUserId: userId, erased });
      if (!erased) {
        res.status(404).json({ error: 'No such user' });
        return;
      }
    } catch (err) {
      log.error('user erasure failed:', { err });
      res.status(500).json({ error: 'Failed to erase user' });
      return;
    }

    if (!removeFromAccess || email === null || actor === null) {
      res.status(204).end();
      return;
    }
    const accountId = erasedAccountId(erasureId);
    try {
      const result = await accessRemoval!.remove(actor, email, accountId);
      log.info('erasure audit:', { action: 'remove-from-access', actorUserId: req.userId, account: accountId, files: result.removedFrom.length });
      res.json({ erased: true, accessRemoval: { ok: true, ...result } });
    } catch (err) {
      log.error('removing the erased account from access files failed:', { err, account: accountId });
      let stillNamedIn: string[] = [];
      try {
        stillNamedIn = await accessRemoval!.filesNaming(email);
      } catch (scanErr) {
        log.warn('could not list the files still naming the erased account:', { err: scanErr });
      }
      const message =
        err instanceof WorkflowDomainError && err.status < 500
          ? err.message
          : 'The change to roles, groups and access rules could not be committed.';
      res.json({ erased: true, accessRemoval: { ok: false, error: message, removedFrom: [], stillNamedIn } });
    }
  });

  return router;
}
