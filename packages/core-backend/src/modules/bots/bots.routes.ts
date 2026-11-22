import express from 'express';
import type { AuthUser } from '@bevel-software/platform-shared';
import { logger } from '../../shared/logging.js';
import type { IGrantRewriter } from './bot-domain-change.js';
import '../auth/index.js'; // Express Request augmentation (req.userId / req.userEmail)

const log = logger('bots');

/** What the domain routes need of the bots mechanism. */
export interface BotsDomainService {
  domain(): string;
  changeDomain(by: AuthUser, input: unknown, rewriter?: IGrantRewriter): Promise<{ domain: string; changeRequest: number | null }>;
}

/**
 * The bots' domain, for the distribution's settings screen: anyone signed in
 * reads it (an address in an access rule is written with it), only an admin
 * changes it. Core holds the setting and its rules; the screen is the
 * distribution's.
 */
export function createBotsRoutes(deps: {
  bots: BotsDomainService;
  isAdmin: (email: string | undefined) => Promise<boolean>;
  resolveUser: (req: express.Request) => Promise<AuthUser | null>;
  rewriter?: IGrantRewriter;
}): express.Router {
  const router = express.Router();

  router.get('/bots/domain', (_req, res) => {
    res.json({ domain: deps.bots.domain() });
  });

  router.put('/bots/domain', async (req, res) => {
    try {
      if (!(await deps.isAdmin(req.userEmail))) {
        return void res.status(403).json({ error: "Only an admin can change the bots' domain." });
      }
      const user = await deps.resolveUser(req);
      if (!user) return void res.status(401).json({ error: 'Not authenticated' });
      const changed = await deps.bots.changeDomain(user, (req.body ?? {}).domain, deps.rewriter);
      res.json(changed);
    } catch (err) {
      if (err instanceof Error && (err as { status?: number }).status === 422) {
        return void res.status(422).json({ error: err.message });
      }
      log.error("changing the bots' domain failed:", { err });
      res.status(500).json({ error: 'Internal error' });
    }
  });

  return router;
}
