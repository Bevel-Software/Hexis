import express from 'express';
import { logger } from '../../shared/logging.js';
import type { IAdminAccessService } from '../admin/admin.interface.js';
import { TokenNotFoundError } from '../tool-auth/external-api-key.errors.js';
import type { IExternalApiKeyService } from '../tool-auth/external-api-key.interface.js';
import { AuditPrincipalNotFoundError, type AuditPrincipalRef, type IAgentAuditService } from './audit.contract.js';
import { MAX_EVENT_PAGE } from './agent-audit.service.js';
import '../auth/auth.middleware.js'; // Express Request augmentation (req.userId / req.userEmail)

const log = logger('audit');

/** Shape of the id columns (any uuid version; case-insensitive). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DEFAULT_EVENT_PAGE = 50;

/**
 * The Audit log's routes, JWT-only (mounted behind the session middleware):
 *
 *   GET    /api/audit/principals?scope=me|all           — agents + keys, with owners and event counts
 *   GET    /api/audit/principals/:kind/:id/events        — one principal's events, newest first, cursor-paged
 *   DELETE /api/audit/agents/:id                         — revoke an agent (owner or admin)
 *   DELETE /api/audit/keys/:id                           — revoke a key (owner or admin)
 *
 * Everyone may read and revoke their OWN rows; `scope=all` and anyone else's
 * rows are admins' (per request, through {@link IAdminAccessService}). Both
 * revokes are recorded as the owner's or an admin's doing, so the owner's
 * page can say which. Keys keep their existing per-user and admin routes;
 * the one here exists so the page has a single client for both kinds.
 */
export function createAuditRoutes(
  audit: IAgentAuditService,
  keys: Pick<IExternalApiKeyService, 'revoke' | 'revokeAny'>,
  adminAccess: IAdminAccessService,
): express.Router {
  const router = express.Router();

  const isAdmin = (req: express.Request) => adminAccess.isAdmin(req.userEmail);

  /** The principal named by the URL, or null when it names none (a malformed id is a not-found, not a 500). */
  const principalOf = (req: express.Request): AuditPrincipalRef | null => {
    const kind = String(req.params.kind);
    const id = String(req.params.id);
    if ((kind !== 'key' && kind !== 'agent') || !UUID_RE.test(id)) return null;
    return { kind, id };
  };

  /** Whether the caller may read or revoke `principal`: its owner, or an admin. Null when there is no such principal. */
  const mayAct = async (req: express.Request, principal: AuditPrincipalRef): Promise<boolean | null> => {
    const owner = await audit.ownerOf(principal);
    if (owner === null) return null;
    if (owner === req.userId) return true;
    return isAdmin(req);
  };

  router.get('/audit/principals', async (req, res) => {
    try {
      const all = req.query.scope === 'all';
      if (all && !(await isAdmin(req))) {
        res.status(403).json({ error: 'Admins only' });
        return;
      }
      const principals = await audit.listPrincipals(all ? 'all' : { userId: req.userId! });
      res.json({ principals });
    } catch (err) {
      log.error('list principals failed:', { err });
      res.status(500).json({ error: 'Failed to load the audit log' });
    }
  });

  router.get('/audit/principals/:kind/:id/events', async (req, res) => {
    const principal = principalOf(req);
    if (!principal) {
      res.status(404).json({ error: 'No such agent or key' });
      return;
    }
    try {
      const allowed = await mayAct(req, principal);
      if (allowed === null) {
        res.status(404).json({ error: 'No such agent or key' });
        return;
      }
      if (!allowed) {
        res.status(403).json({ error: 'Not yours' });
        return;
      }
      const rawLimit = Number(req.query.limit);
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, MAX_EVENT_PAGE) : DEFAULT_EVENT_PAGE;
      const before = typeof req.query.before === 'string' && req.query.before ? req.query.before : undefined;
      res.json(await audit.listEvents(principal, { before, limit }));
    } catch (err) {
      log.error('list events failed:', { err });
      res.status(500).json({ error: 'Failed to load events' });
    }
  });

  router.delete('/audit/agents/:id', async (req, res) => {
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) {
      res.status(404).json({ error: 'No such agent' });
      return;
    }
    try {
      const admin = await isAdmin(req);
      // An admin revokes deployment-wide and is recorded as such; anyone else
      // is scoped to their own connections, and a foreign id reads as absent.
      await audit.revokeConnection(id, admin ? 'admin' : 'owner', admin ? undefined : req.userId!);
      log.info('revoke audit:', { action: admin ? 'admin-revoke-agent' : 'owner-revoke-agent', actorUserId: req.userId, connectionId: id });
      res.json({ status: 'revoked' });
    } catch (err) {
      if (err instanceof AuditPrincipalNotFoundError) {
        res.status(404).json({ error: err.message });
        return;
      }
      log.error('revoke agent failed:', { err });
      res.status(500).json({ error: 'Failed to revoke this agent' });
    }
  });

  router.delete('/audit/keys/:id', async (req, res) => {
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) {
      res.status(404).json({ error: 'Token not found' });
      return;
    }
    try {
      const admin = await isAdmin(req);
      // Own key: the owner's revoke (recorded as theirs). Anyone else's: only
      // an admin may, and it is recorded as an admin's so the owner is told.
      const owner = await audit.ownerOf({ kind: 'key', id });
      if (owner === req.userId) {
        await keys.revoke(id, req.userId!);
      } else if (admin) {
        await keys.revokeAny(id);
        log.info('revoke audit:', { action: 'admin-revoke-key', actorUserId: req.userId, tokenId: id });
      } else {
        res.status(owner === null ? 404 : 403).json({ error: owner === null ? 'Token not found' : 'Not yours' });
        return;
      }
      res.json({ status: 'revoked' });
    } catch (err) {
      if (err instanceof TokenNotFoundError) {
        res.status(404).json({ error: err.message });
        return;
      }
      log.error('revoke key failed:', { err });
      res.status(500).json({ error: 'Failed to revoke this key' });
    }
  });

  return router;
}
