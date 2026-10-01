import express from 'express';
import { logger } from '../../shared/logging.js';

const log = logger('skills');
import '../auth/auth.middleware.js'; // Express Request.userId / userEmail augmentation
import type { AuthUser, IWorkflowService } from '@bevel-software/platform-shared';
import type { IAccessControl } from '../access/access-control.interface.js';
import { folderTarget } from '../access/access-requests.contract.js';
import { AccessRequestsService } from '../access/access-requests.service.js';
import { WorkflowDomainError } from '../../shared/domain-errors.js';
import { domainErrorBody } from '../../shared/http-errors.js';
import type { KbContext } from '../../shared/kb-context.js';
import type { WorkspaceService } from '../workspace/workspace.service.js';
import type { JoinRequestsService } from '../plugins/join-requests.service.js';
import type { ISkillService } from './skills.contract.js';

/**
 * Asking for WRITE on a shared skill — the same machinery as asking to join a
 * plugin, pointed at a skill folder instead of a plugin folder.
 *
 *   POST /api/skills/:name/access-request               → { ok, number }
 *   GET  /api/skills/:name/access-requests              → { requests }   (skill editors)
 *   POST /api/skills/:name/access-requests/:n/reconcile → { closed }
 *
 * Why it exists: linking a skill into a plugin needs write on the skill's
 * rules (the link grants the plugin's principal there), and a plugin manager
 * often has no say over a skill some other scope owns. The request is opened
 * by the shared `AccessRequestsService` — the same one the Manage access
 * dialog's Request access uses — keyed on the skill FOLDER path, so this
 * button and a Can edit request on that same folder are ONE request, shown in
 * the skill page's banner and in the folder's dialog alike.
 *
 * Fail-closed like the skill catalog: a skill the caller cannot read answers
 * as unknown, and the editors' listing answers `[]` to anyone else.
 */
export function createSkillAccessRequestRoutes(deps: {
  skillService: ISkillService;
  accessControl: IAccessControl;
  workflow: IWorkflowService;
  workspaceService: WorkspaceService;
  joinRequests: JoinRequestsService;
  kb: KbContext;
  resolveUser: (req: express.Request) => Promise<AuthUser | null>;
}): express.Router {
  const { skillService, accessControl, workflow, workspaceService, joinRequests, kb, resolveUser } = deps;
  const router = express.Router();
  const wsId = () => kb.defaultWorkspaceId();
  const rulesOf = (folder: string) => `${folder}/access.md`;
  // The same opener the Manage access dialog uses, pointed at a skill's
  // folder. Keyed on that folder's PATH, which is what makes this button and
  // a Can edit request on the same folder one request rather than two.
  const requests = new AccessRequestsService({
    workflow,
    workspaceService,
    lifecycle: joinRequests,
    kb,
  });

  /** The skill the caller may read, by name — or null after answering 404. */
  async function readableSkill(
    req: express.Request,
    res: express.Response,
  ): Promise<{ user: AuthUser; folder: string; name: string } | null> {
    const user = await resolveUser(req);
    if (!user) {
      res.status(401).json({ error: 'Unauthenticated' });
      return null;
    }
    const name = String(req.params.name);
    const skill = (await skillService.listSkills(user.email)).find((s) => s.name === name);
    if (!skill) {
      res.status(404).json({ error: 'Unknown skill', kind: 'unknown-skill' });
      return null;
    }
    return { user, folder: skill.path, name };
  }

  router.post('/skills/:name/access-request', async (req, res) => {
    try {
      const ctx = await readableSkill(req, res);
      if (!ctx) return;
      const { user, folder, name } = ctx;
      if (await accessControl.canWrite(wsId(), user.email, rulesOf(folder))) {
        res.status(409).json({ error: 'You can already edit this skill', kind: 'already-writable' });
        return;
      }
      const { number } = await requests.open({
        user,
        target: folderTarget(folder),
        itemName: name,
        level: 'write',
      });
      res.json({ ok: true, number });
    } catch (err) {
      if (err instanceof WorkflowDomainError) {
        res.status(err.status).json(domainErrorBody(err));
        return;
      }
      log.error('failed to open an access request:', { err });
      res.status(500).json({ error: 'Failed to request access' });
    }
  });

  /** The caller as an EDITOR of the skill's rules, or null after answering. */
  async function requireEditor(
    req: express.Request,
    res: express.Response,
    onDenied: () => void,
  ): Promise<{ user: AuthUser; folder: string } | null> {
    const ctx = await readableSkill(req, res);
    if (!ctx) return null;
    if (!(await accessControl.canWrite(wsId(), ctx.user.email, rulesOf(ctx.folder)))) {
      onDenied();
      return null;
    }
    return ctx;
  }

  router.get('/skills/:name/access-requests', async (req, res) => {
    try {
      const ctx = await requireEditor(req, res, () => res.json({ requests: [] }));
      if (!ctx) return;
      const crs = await workflow.listChangeRequests();
      res.json({ requests: await joinRequests.list(ctx.folder, folderTarget(ctx.folder), crs, ctx.user) });
    } catch (err) {
      log.error('failed to list access requests:', { err });
      res.status(500).json({ error: 'Failed to list access requests' });
    }
  });

  router.post('/skills/:name/access-requests/:number/reconcile', async (req, res) => {
    try {
      const ctx = await requireEditor(req, res, () => res.status(404).json({ error: 'Not found' }));
      if (!ctx) return;
      const crNumber = Number(req.params.number);
      if (!Number.isSafeInteger(crNumber) || crNumber <= 0) {
        res.status(400).json({ error: 'Invalid change request number' });
        return;
      }
      const cr = await workflow.getChangeRequest(crNumber);
      if (!cr) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      res.json({ closed: await joinRequests.reconcile(ctx.folder, folderTarget(ctx.folder), cr, ctx.user) });
    } catch (err) {
      log.error('failed to reconcile an access request:', { err });
      res.status(500).json({ error: 'Failed to reconcile the request' });
    }
  });

  return router;
}
