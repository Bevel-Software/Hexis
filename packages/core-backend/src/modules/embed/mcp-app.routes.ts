import express, { type RequestHandler } from 'express';
import type { McpAppManifest } from '@bevel-software/platform-mcp-core';

/**
 * The deployment's MCP Apps over REST, for the LOCAL MCP server.
 *
 * `hexis-mcp` bridges a host to this deployment over HTTP: it discovers the
 * tools as a UTCP manual, which has nowhere to carry a view, and it serves
 * `resources/read` itself. So it needs the manifest — which tools carry a
 * view, and the view's HTML and sandbox metadata — as data. One route, one
 * answer, so the local server advertises the same apps the hosted endpoint
 * does without knowing what any of them render.
 *
 * `manualAuth` for the same reason `all-tools` and `catalog-revision` use it:
 * this is the agent surface, reached with a connection key or an exchanged
 * grant. Nothing here is per-caller — every connection gets the same view —
 * so the credential is a door, not a filter.
 */
export function createMcpAppRoutes(
  apps: { manifest(): Promise<McpAppManifest> },
  manualAuth: RequestHandler,
): express.Router {
  const router = express.Router();

  router.get('/agent/mcp-app', manualAuth, async (_req, res) => {
    try {
      const manifest = await apps.manifest();
      // The view's HTML rides the manifest rather than sitting behind a
      // second round trip per resource: it is one small static file, the
      // local server needs all of it before it can declare the capability at
      // all, and a second fetch is a second thing that can half-fail.
      res.setHeader('Cache-Control', 'no-store');
      res.json(manifest);
    } catch (err) {
      console.error('[embed] could not build the MCP App manifest:', err);
      res.status(500).json({ error: 'Something went wrong.' });
    }
  });

  return router;
}
