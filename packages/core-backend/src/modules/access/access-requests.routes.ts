import express from 'express';
import type { AuthUser } from '@bevel-software/platform-shared';
import type { IWorkflowService } from '@bevel-software/platform-shared';
import { logger } from '../../shared/logging.js';
import type { KbContext } from '../../shared/kb-context.js';
import { branchForWorkspaceId } from '../../shared/workspace-id.js';
import type { AuthService } from '../auth/auth.service.js';
import type { WorkspaceService } from '../workspace/workspace.service.js';
import type { IAccessControl } from './access-control.interface.js';
import {
  AccessMutationError,
  AccessMutationService,
  fileCarriesAccessRules,
  governingFolderOf,
  type TargetKind,
} from './access-mutation.service.js';
import { toHttpError as sharedToHttpError } from './admin-route-helpers.js';
import {
  isRequestLevel,
  rulesFileFor,
  REQUEST_NOTE_MAX,
  type AccessRequestTarget,
  type IAccessRequestLifecycle,
} from './access-requests.contract.js';
import {
  AccessRequestsService,
  extractRequestNote,
  itemNameOf,
} from './access-requests.service.js';
import '../auth/auth.middleware.js'; // Express Request.userId augmentation

const log = logger('access.request');

/**
 * Asking for Can edit or Owner on one item, and the editors' answer.
 *
 *   POST /api/workspace/:id/access/request                  → { ok, number, state, level }
 *   GET  /api/workspace/:id/access/request?path=&kind=      → { state, level?, number? }
 *   GET  /api/workspace/:id/access/requests?path=&kind=     → { requests }   (editors)
 *   POST /api/workspace/:id/access/requests/:n/reconcile    → { closed }
 *
 * LIVE WORKSPACE ONLY. A draft branch's rules may differ from the ones the
 * person is asking about, and a request opened against a draft would propose a
 * grant into a branch nobody merges — so every route here refuses any
 * workspace but the default one, rather than quietly retargeting.
 *
 * Fail-closed like the rest of the access family: an item the caller cannot
 * read answers as unknown, and the editors' listing answers `[]` to everyone
 * else rather than 403 — "am I an editor here" stays a question only the
 * server answers.
 */
export function createAccessRequestRoutes(deps: {
  accessControl: IAccessControl;
  workspaceService: WorkspaceService;
  authService: AuthService;
  workflow: IWorkflowService;
  lifecycle: IAccessRequestLifecycle;
  kb: KbContext;
}): express.Router {
  const { accessControl, workspaceService, authService, workflow, lifecycle, kb } = deps;
  const { kbDirName } = kb;
  const router = express.Router({ mergeParams: true });
  const mutation = new AccessMutationService(workspaceService, accessControl, kbDirName);
  const requests = new AccessRequestsService({ workflow, workspaceService, lifecycle, kb });

  async function requireUser(
    req: express.Request,
    res: express.Response,
  ): Promise<AuthUser | null> {
    if (!req.userId) {
      res.status(401).json({ error: 'Unauthenticated' });
      return null;
    }
    const user = await authService.getUserById(req.userId);
    if (!user) {
      res.status(401).json({ error: 'User not found' });
      return null;
    }
    return user;
  }

  /** Workspace-relative (what the dialog holds) → repo-relative (what the model speaks). */
  function toRepoRelative(p: string): string {
    const prefix = `${kbDirName}/`;
    if (p === kbDirName) return '';
    return p.startsWith(prefix) ? p.slice(prefix.length) : p;
  }

  /**
   * Refuse a target that could escape the KB repo, or that is spelled in more
   * than one way. Mirrors the grant route's guard — the branch name and the
   * spliced path are both derived from this string, so two spellings of one
   * item would be two different requests.
   */
  function assertSafeTarget(repoRelTarget: string, kind: TargetKind): void {
    if (kind === 'file' && !repoRelTarget) {
      throw new AccessMutationError('file path is required');
    }
    if (
      repoRelTarget.startsWith('/') ||
      repoRelTarget.includes('\\') ||
      repoRelTarget.includes('\0') ||
      repoRelTarget.split('/').some((s) => s === '..' || s === '.')
    ) {
      throw new AccessMutationError('path must stay inside the KB repo');
    }
  }

  /**
   * The (live workspace, readable item) pair every route here needs, or null
   * after the refusal has been answered.
   *
   * The two refusals are deliberately different shapes: a non-default
   * workspace is the CALLER asking the wrong question (400), while an item the
   * caller cannot read answers exactly as one that does not exist (404) — a
   * 403 would confirm the item is there.
   */
  async function resolveTarget(
    req: express.Request,
    res: express.Response,
    rawPath: unknown,
    rawKind: unknown,
  ): Promise<{ user: AuthUser; target: AccessRequestTarget; wsId: string } | null> {
    const user = await requireUser(req, res);
    if (!user) return null;
    const wsId = kb.defaultWorkspaceId();
    if (branchForWorkspaceId(String(req.params.id)) !== kb.defaultBranch) {
      res.status(400).json({
        error: 'Access requests are only made on the live workspace.',
        kind: 'not-live-workspace',
      });
      return null;
    }
    if (typeof rawPath !== 'string') {
      res.status(400).json({ error: 'path is required', kind: 'access-error' });
      return null;
    }
    const kind: TargetKind = rawKind === 'folder' ? 'folder' : 'file';
    const target: AccessRequestTarget = { path: toRepoRelative(rawPath), kind };
    try {
      assertSafeTarget(target.path, kind);
    } catch (err) {
      const { status, body } = sharedToHttpError(err, 'access');
      res.status(status).json(body);
      return null;
    }
    if (!(await accessControl.canRead(wsId, user.email, target.path))) {
      res.status(404).json({ error: 'Not found', kind: 'unknown-target' });
      return null;
    }
    return { user, target, wsId };
  }

  /** Can the caller change this item's rules — the gate an Accept runs through. */
  const isEditor = (wsId: string, email: string, target: AccessRequestTarget) =>
    accessControl.canWrite(wsId, email, rulesFileFor(target));

  /**
   * A FILE that cannot hold rules of its own is governed by its folder, and
   * there is nothing here to request. The dialog already points at the folder
   * for these; the route says the same thing rather than splicing YAML into a
   * PDF. Content counts as much as the name — bytes that are not text refuse
   * too, exactly as the grant route refuses them.
   */
  async function assertCanCarryRules(wsId: string, target: AccessRequestTarget): Promise<void> {
    if (target.kind !== 'file') return;
    if (fileCarriesAccessRules(target.path) && (await mutation.targetHoldsText(wsId, target.path))) {
      return;
    }
    throw new AccessMutationError(
      `Access for this file is managed on its folder. Ask there instead.`,
      409,
      { kind: 'folder-governs', folder: governingFolderOf(target.path) },
    );
  }

  router.post('/workspace/:id/access/request', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const ctx = await resolveTarget(req, res, body.path, body.kind);
    if (!ctx) return;
    const { user, target, wsId } = ctx;
    try {
      if (!isRequestLevel(body.level)) {
        throw new AccessMutationError('level must be "write" or "owner"');
      }
      const note = typeof body.note === 'string' ? body.note : '';
      if (typeof body.note !== 'undefined' && typeof body.note !== 'string') {
        throw new AccessMutationError('note must be text');
      }
      if (note.length > REQUEST_NOTE_MAX) {
        throw new AccessMutationError(`A note can be at most ${REQUEST_NOTE_MAX} characters.`);
      }
      await assertCanCarryRules(wsId, target);
      if (await isEditor(wsId, user.email, target)) {
        throw new AccessMutationError(
          `You can already change who can use this ${target.kind}.`,
          409,
          { kind: 'already-writable' },
        );
      }
      const opened = await requests.open({
        user,
        target,
        itemName: itemNameOf(target.path),
        level: body.level,
        note,
      });
      res.json({ ok: true, state: 'pending', number: opened.number, level: opened.level });
    } catch (err) {
      const { status, body: errBody } = sharedToHttpError(err, 'access');
      if (status >= 500) log.error('failed to open an access request:', { err });
      res.status(status).json(errBody);
    }
  });

  router.get('/workspace/:id/access/request', async (req, res) => {
    const ctx = await resolveTarget(req, res, req.query.path, req.query.kind);
    if (!ctx) return;
    try {
      res.json(await requests.status(ctx.user, ctx.target));
    } catch (err) {
      log.error('failed to read an access request:', { err });
      res.status(500).json({ error: 'Failed to read the request' });
    }
  });

  router.get('/workspace/:id/access/requests', async (req, res) => {
    const ctx = await resolveTarget(req, res, req.query.path, req.query.kind);
    if (!ctx) return;
    const { user, target, wsId } = ctx;
    try {
      if (!(await isEditor(wsId, user.email, target))) {
        res.json({ requests: [] });
        return;
      }
      const crs = await workflow.listChangeRequests();
      const rows = await lifecycle.list(target.path, target, crs, user);
      // The note lives in the request's description and nowhere else, so it
      // is read back per request. Bounded by the open requests on ONE item —
      // a handful at most — and a detail that cannot be fetched costs the
      // note, never the line it belongs to.
      const withNotes = await Promise.all(
        rows.map(async (row) => {
          const detail = await workflow
            .getChangeRequestDetail(row.number, { patches: false })
            .catch(() => null);
          const note = extractRequestNote(detail?.body);
          return note ? { ...row, note } : row;
        }),
      );
      res.json({ requests: withNotes });
    } catch (err) {
      log.error('failed to list access requests:', { err });
      res.status(500).json({ error: 'Failed to list access requests' });
    }
  });

  router.post('/workspace/:id/access/requests/:number/reconcile', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const ctx = await resolveTarget(req, res, body.path, body.kind);
    if (!ctx) return;
    const { user, target, wsId } = ctx;
    try {
      if (!(await isEditor(wsId, user.email, target))) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      const number = Number(req.params.number);
      if (!Number.isSafeInteger(number) || number <= 0) {
        res.status(400).json({ error: 'Invalid change request number' });
        return;
      }
      const cr = await workflow.getChangeRequest(number);
      if (!cr) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      res.json({ closed: await lifecycle.reconcile(target.path, target, cr, user) });
    } catch (err) {
      log.error('failed to reconcile an access request:', { err });
      res.status(500).json({ error: 'Failed to reconcile the request' });
    }
  });

  return router;
}
