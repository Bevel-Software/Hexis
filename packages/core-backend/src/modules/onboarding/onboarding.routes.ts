import express from 'express';
import type { AuthUser } from '@bevel-software/platform-shared';
import { logger } from '../../shared/logging.js';
import { WorkflowDomainError } from '../../shared/domain-errors.js';
import type { IStarterPackService } from './onboarding.contract.js';
import '../auth/auth.middleware.js'; // Express Request augmentation (req.userId)

const log = logger('starter-packs');

/**
 * The starter-pack question (see `starter-pack.service.ts`), JWT-only:
 *
 *   GET  /api/onboarding/starter-packs → `StarterPacksAnswer`
 *   POST /api/onboarding/starter-pack  { id } → `StarterPackApplied`
 *
 * The GET answers anyone signed in — a member is never offered the question
 * but follows the chosen pack's first-page prompt like everybody else — and
 * is never cached: the answer changes the moment someone chooses. The POST is
 * the admin's (403 otherwise; the service checks), 409 once the question is
 * no longer asked, and `id: "none"` is "I'll start from scratch".
 */
export function createOnboardingRoutes(
  starterPacks: IStarterPackService,
  resolveUser: (req: express.Request) => Promise<AuthUser | null>,
): express.Router {
  const router = express.Router();

  /**
   * The caller, or null once the response is written: 401 for nobody signed
   * in, and 500 when that could not be told — a database outage is not an
   * expired session, and saying so sends people to sign in again for nothing.
   */
  async function caller(req: express.Request, res: express.Response): Promise<AuthUser | null> {
    let user: AuthUser | null;
    try {
      user = await resolveUser(req);
    } catch (err) {
      log.error('could not resolve the caller:', { err });
      res.status(500).json({ error: 'Could not tell who is signed in. Try again.' });
      return null;
    }
    if (!user) res.status(401).json({ error: 'Unauthenticated' });
    return user;
  }

  router.get('/onboarding/starter-packs', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const user = await caller(req, res);
    if (!user) return;
    try {
      res.json(await starterPacks.status(user));
    } catch (err) {
      log.error('starter packs status failed:', { err });
      res.status(500).json({ error: 'Could not load the starter packs' });
    }
  });

  router.post('/onboarding/starter-pack', express.json(), async (req, res) => {
    const user = await caller(req, res);
    if (!user) return;
    const id = (req.body as { id?: unknown } | undefined)?.id;
    if (typeof id !== 'string' || !id.trim()) {
      res.status(400).json({ error: 'Say which starter pack: `id`, or "none" to skip.' });
      return;
    }
    try {
      res.json(await starterPacks.choose(user, id.trim()));
    } catch (err) {
      if (err instanceof WorkflowDomainError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      // The batch write's status-less refusal: one of the pack's paths is
      // being written by someone else right now. Nothing was committed.
      if (err instanceof Error && /locked by /.test(err.message)) {
        res.status(409).json({ error: 'Someone is editing the knowledge base right now. Try again in a moment.' });
        return;
      }
      log.error('adding a starter pack failed:', { err });
      res.status(500).json({ error: 'Could not add the starter pages. Nothing was changed.' });
    }
  });

  return router;
}
