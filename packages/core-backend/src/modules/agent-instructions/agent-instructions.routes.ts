import express, { type RequestHandler } from 'express';
import { composeAgentInstructions } from './compose.js';
import type { AgentPreambleReader } from './read-preamble.js';

/**
 * The agent-facing instructions route, mounted on the tools router beside
 * `GET /agent/all-tools` and behind the same `manualAuth` (a connection key,
 * an internal token or a browser JWT):
 *
 *   GET /agent/instructions   the composed text both channels are built from,
 *                             as the composer returns it. The local `hexis-mcp`
 *                             bridge reads it at startup; the External agent
 *                             access card reads it to show what agents get.
 *
 * The hosted proxy does NOT call this: it composes in-process at session
 * creation (see `McpService.createSession`). `Cache-Control: no-store`
 * because the text is privileged: it is read with platform rights and may
 * name folders the caller cannot open. A reader throw is a 500, never an
 * empty preamble, so the caller's own fallback decides what to send.
 */
export function createAgentInstructionsRoutes(manualAuth: RequestHandler, readPreamble: AgentPreambleReader): express.Router {
  const router = express.Router();

  router.get('/agent/instructions', manualAuth, async (_req, res) => {
    try {
      const composed = composeAgentInstructions(await readPreamble());
      res.setHeader('Cache-Control', 'no-store');
      res.json(composed);
    } catch (err) {
      console.error('[agent-instructions] reading mcp-description.md failed:', err instanceof Error ? err.message : err);
      res.status(500).json({ error: 'Failed to read the agent instructions' });
    }
  });

  return router;
}
