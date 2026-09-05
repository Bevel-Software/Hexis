import express from 'express';
import '../auth/auth.middleware.js'; // Express Request.userId / userEmail augmentation
import {
  DEFAULT_BRANCH,
  joinBranchFor,
  type AuthUser,
  type IWorkflowService,
} from '@bevel-software/platform-shared';
import type { IAccessControl } from '../access/access-control.interface.js';
import { spliceGrant } from '../access-model/access-splice.js';
import { WorkflowDomainError } from '../../shared/domain-errors.js';
import { workspaceIdForBranch } from '../../shared/workspace-id.js';
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
 * often has no say over a skill some other scope owns. The request is a plain
 * change request whose branch splices `write: <requester>` into the skill
 * folder's `access.md`; the skill's editors see its proposals and accept
 * through the ordinary grant path, and it retires itself once the default
 * branch carries the grant (`JoinRequestsService`, keyed on the skill FOLDER
 * path rather than a plugin name — the branch-name convention takes any
 * exact string).
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
  kbDirName: string;
  resolveUser: (req: express.Request) => Promise<AuthUser | null>;
}): express.Router {
  const { skillService, accessControl, workflow, workspaceService, joinRequests, kbDirName, resolveUser } = deps;
  const router = express.Router();
  const wsId = () => workspaceIdForBranch(DEFAULT_BRANCH);
  const rulesOf = (folder: string) => `${folder}/access.md`;

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
      const branch = joinBranchFor(user.email, folder);
      const existing = (await workflow.listChangeRequestsAuthoredBy(user.email)).find(
        (cr) => cr.state === 'open' && cr.branch === branch,
      );
      if (existing) {
        res.json({ ok: true, number: existing.number });
        return;
      }
      try {
        await workflow.createBranch(wsId(), branch, DEFAULT_BRANCH);
      } catch {
        // exists (or raced) — proceed against it
      }
      const ws = await workspaceService.getOrCreateForBranch(branch);
      const accessPath = `${kbDirName}/${rulesOf(folder)}`;
      // Only a PROVEN absence reads as "no rules yet": any other failure must
      // not be turned into an empty file that a splice then overwrites.
      const current = await workspaceService.readFile(ws.id, accessPath).catch((err: unknown) => {
        const code = (err as { code?: unknown } | null)?.code;
        if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err;
        return '';
      });
      const spliced = spliceGrant(
        current,
        'write',
        { kind: 'user', email: user.email, displayName: user.name },
        { target: 'folder' },
      );
      if (spliced.changed) {
        await workspaceService.writeFile(ws.id, accessPath, spliced.text);
        await workflow.commitChanges(ws.id, user, `Request write access to ${name}`);
      }
      const detail = await workflow.openChangeRequest(ws.id, user, {
        sourceBranch: branch,
        targetBranch: DEFAULT_BRANCH,
        title: `Access request: ${name}`,
        description:
          `${user.name} asked to edit the skill ${name}. An editor of the skill accepts by ` +
          `granting the access this branch proposes; the request closes itself once ` +
          `every proposal has landed.`,
      });
      res.json({ ok: true, number: detail.number });
    } catch (err) {
      if (err instanceof WorkflowDomainError) {
        res.status(err.status).json({ error: err.message, ...(err.payload ?? {}) });
        return;
      }
      console.error('[skills] failed to open an access request:', err);
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
      res.json({ requests: await joinRequests.list(ctx.folder, ctx.folder, crs, ctx.user) });
    } catch (err) {
      console.error('[skills] failed to list access requests:', err);
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
      res.json({ closed: await joinRequests.reconcile(ctx.folder, ctx.folder, cr, ctx.user) });
    } catch (err) {
      console.error('[skills] failed to reconcile an access request:', err);
      res.status(500).json({ error: 'Failed to reconcile the request' });
    }
  });

  return router;
}
