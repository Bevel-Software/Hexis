import express from 'express';
import { logger } from '../../shared/logging.js';
import type { IAgentConnectionStatus } from './audit.contract.js';
import '../auth/auth.middleware.js'; // Express Request augmentation (req.userId)

const log = logger('audit');

/** What the onboarding reads: connected or not, and — once connected — when, as what, and through which kind of credential. */
export interface AgentConnectionResponse {
  connected: boolean;
  /** The agent's most recent call, ISO 8601. */
  at?: string;
  /** The agent's registered client name, or the connection key's label. */
  client?: string;
  /**
   * Which of the two `client` is: `agent` for an OAuth connection's
   * registered name, `key` for a connection key's free-text label. Only an
   * `agent` name says which app connected.
   */
  kind?: 'agent' | 'key';
}

/**
 * GET /api/onboarding/agent-connection — "has an agent of mine reached the
 * platform yet?", JWT-only (mounted behind the session middleware).
 *
 * The connect-your-agent page and the Get set up list ask it once on
 * arrival, and again when the person comes back to the tab; the moment it
 * changes is told by the `agent-connected` event the use-stamp paths emit
 * over the event stream, so nothing asks on a timer. It answers for the
 * CALLER alone: the user is the token's, and nothing in the request can name
 * anyone else — there is no parameter to try.
 *
 * `no-store` because the answer is expected to change between two asks; a
 * cached "not yet" would keep a page waiting on an agent that has already
 * arrived.
 */
export function createAgentConnectionRoutes(status: IAgentConnectionStatus): express.Router {
  const router = express.Router();

  router.get('/onboarding/agent-connection', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const use = await status.lastAgentUse(req.userId!);
      const body: AgentConnectionResponse = use
        ? { connected: true, at: use.at.toISOString(), client: use.client, kind: use.kind }
        : { connected: false };
      res.json(body);
    } catch (err) {
      log.error('agent connection status failed:', { err });
      res.status(500).json({ error: 'Could not check your agent' });
    }
  });

  return router;
}
