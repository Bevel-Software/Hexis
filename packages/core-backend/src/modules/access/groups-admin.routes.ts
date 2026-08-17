import express from 'express';
import type { AuthUser } from '@bevel-software/platform-shared';
import type { IAdminAccessService } from '../admin/admin.interface.js';
import { WorkflowDomainError } from '../workflow/workflow.errors.js';
import { canonicalRoleName } from './access-control.service.js';
import type { GroupsAdminService } from './groups-admin.service.js';
import '../auth/auth.middleware.js'; // Express Request augmentation

/**
 * Admin surface for GROUPS — the "who you are" half of the roles/groups
 * split. Manual-mode CRUD on `groups.yaml`; in IdP mode the service refuses
 * mutations with a typed 409 (`kind: 'idp-mode'`) and this router simply
 * relays it. Admin-gated like the other admin routers: the roster is the org
 * chart, not something every signed-in user may enumerate.
 */
export function createGroupsAdminRoutes(deps: {
  groupsAdmin: GroupsAdminService;
  adminAccess: IAdminAccessService;
  /** Resolve the acting user for commit attribution. */
  getUserById: (id: string) => Promise<AuthUser | null>;
}): express.Router {
  const { groupsAdmin, adminAccess, getUserById } = deps;
  const router = express.Router();

  const requireAdmin: express.RequestHandler = async (req, res, next) => {
    if (!(await adminAccess.isAdmin(req.userEmail))) {
      res.status(403).json({ error: 'Admins only' });
      return;
    }
    next();
  };

  const actorOf = async (req: express.Request): Promise<AuthUser> => {
    const user = req.userId ? await getUserById(req.userId) : null;
    if (user) return user;
    // The JWT authenticated but the row is gone (erased mid-session) — the
    // identity claims are still the honest attribution we hold.
    return { id: req.userId ?? 'unknown', email: req.userEmail ?? 'unknown', name: req.userEmail ?? 'unknown' };
  };

  const sendError = (res: express.Response, err: unknown): void => {
    if (err instanceof WorkflowDomainError) {
      res.status(err.status).json({ error: err.message, ...(err.payload ?? {}) });
      return;
    }
    console.error('[groups] admin route failure:', err instanceof Error ? err.message : err);
    res.status(500).json({ error: 'Group operation failed.' });
  };

  const requireNonEmptyString = (value: unknown, field: string): string => {
    if (typeof value !== 'string' || !value.trim()) {
      throw new WorkflowDomainError(`${field} is required`, 400);
    }
    return value.trim();
  };

  // GET /api/admin/groups — mode + roster (manual groups with references).
  router.get('/admin/groups', requireAdmin, async (_req, res) => {
    try {
      res.json(await groupsAdmin.getRoster());
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post('/admin/groups', requireAdmin, async (req, res) => {
    try {
      const displayName = requireNonEmptyString((req.body ?? {}).displayName, 'displayName');
      res.json(await groupsAdmin.createGroup(await actorOf(req), displayName));
    } catch (err) {
      sendError(res, err);
    }
  });

  router.delete('/admin/groups/:canonical', requireAdmin, async (req, res) => {
    try {
      const canonical = canonicalRoleName(String(req.params.canonical));
      res.json(await groupsAdmin.deleteGroup(await actorOf(req), canonical));
    } catch (err) {
      sendError(res, err);
    }
  });

  // PATCH /api/admin/groups/:canonical { newDisplayName } — rename;
  // canonical-changing renames rewrite grant references atomically.
  router.patch('/admin/groups/:canonical', requireAdmin, async (req, res) => {
    try {
      const canonical = canonicalRoleName(String(req.params.canonical));
      const newDisplayName = requireNonEmptyString((req.body ?? {}).newDisplayName, 'newDisplayName');
      res.json(await groupsAdmin.renameGroup(await actorOf(req), canonical, newDisplayName));
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post('/admin/groups/:canonical/members', requireAdmin, async (req, res) => {
    try {
      const canonical = canonicalRoleName(String(req.params.canonical));
      const email = requireNonEmptyString((req.body ?? {}).email, 'email');
      res.json(await groupsAdmin.addMember(await actorOf(req), canonical, email));
    } catch (err) {
      sendError(res, err);
    }
  });

  router.delete('/admin/groups/:canonical/members/:email', requireAdmin, async (req, res) => {
    try {
      const canonical = canonicalRoleName(String(req.params.canonical));
      res.json(
        await groupsAdmin.removeMember(await actorOf(req), canonical, String(req.params.email)),
      );
    } catch (err) {
      sendError(res, err);
    }
  });

  return router;
}
