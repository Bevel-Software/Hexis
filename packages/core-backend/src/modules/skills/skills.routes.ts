import express from 'express';
import '../auth/auth.middleware.js'; // Express Request.userId / userEmail augmentation
import type { IPendingSkillService, ISkillService } from './skills.contract.js';

/**
 * Browser-facing (JWT) skill routes for the `/`-command menu, mounted behind
 * `authMiddleware`. Backed by the SAME `SkillService` as the agent tool surface,
 * so discovery, default-branch pinning, and per-user `canRead` filtering live
 * ONCE — the frontend never re-implements skill discovery or bypasses access.
 *
 *   GET /api/skills            → { skills: SkillSummary[] }   (filtered to this user)
 *   GET /api/skills/pending    → { skills: PendingSkill[] }   (proposed, not released)
 *   GET /api/skills/:name      → GetSkillResult               (body + files)
 *   GET /api/skills/:name?file=… → GetSkillResult             (a bundled file's content)
 */
export function createSkillsRoutes(
  skillService: ISkillService,
  pendingSkills?: IPendingSkillService,
): express.Router {
  const router = express.Router();

  router.get('/skills', async (req, res) => {
    const email = req.userEmail;
    if (!email) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    res.json({ skills: await skillService.listSkills(email) });
  });

  /**
   * BEFORE `/skills/:name`, and it has to stay there: Express matches in
   * declaration order, so the parameterised route would otherwise swallow
   * `pending` and answer "no such skill".
   *
   * Optional dependency so a host that composes its own service set gets an
   * empty review shelf rather than a 404 the frontend has to special-case.
   */
  router.get('/skills/pending', async (req, res) => {
    const email = req.userEmail;
    if (!email) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    res.json({ skills: pendingSkills ? await pendingSkills.listPendingSkills(email) : [] });
  });

  router.get('/skills/:name', async (req, res) => {
    const email = req.userEmail;
    if (!email) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    const file = typeof req.query.file === 'string' ? req.query.file : undefined;
    res.json(await skillService.getSkill(email, req.params.name, file));
  });

  return router;
}
