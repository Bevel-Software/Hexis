import express, { type Request, type RequestHandler } from 'express';
import '@utcp/http'; // side effect: register the 'http' call-template type
import { CallTemplateSerializer, type CallTemplate } from '@utcp/sdk';
import { type IToolManualService, EXTERNAL_KB_MANUAL_NAME } from './tool-manuals.contract.js';
import '../auth/auth.middleware.js'; // Express Request augmentation (req.userId / req.userEmail)
import '../tool-auth/tool-auth.middleware.js'; // Express Request augmentation (req.toolAuth)

/** Resolve a connection-key/internal-token user id to its email (per-caller ACL). */
export type ResolveUserEmail = (userId: string) => Promise<string | undefined>;

const callTemplateSerializer = new CallTemplateSerializer();

/** The external KB manual's discovery call-template — Bevel's own `/api/agent/utcp`. */
function kbManualTemplate(): CallTemplate {
  return callTemplateSerializer.validateDict({
    name: EXTERNAL_KB_MANUAL_NAME,
    call_template_type: 'http',
    http_method: 'GET',
    url: '${API_URL}/api/agent/utcp',
    content_type: 'application/json',
    headers: { Authorization: 'Bearer ${CONNECTION_KEY}' },
  });
}

/**
 * Agent-facing tool-manual routes (mounted on the tools router, BEFORE the JWT
 * `/api` mounts, behind `manualAuth`):
 *   GET /agent/all-tools       — the list of manual call-templates (KB + the
 *                                caller's accessible `.tool`s). The MCP proxy
 *                                registers each on its per-session UTCP client.
 *   GET /tools/:slug/manual    — an inline `.tool`'s embedded tools as a UTCP
 *                                manual (so inline needs no extra client plugin).
 */
export function createToolManualsAgentRoutes(
  toolManualService: IToolManualService,
  manualAuth: RequestHandler,
  resolveUserEmail: ResolveUserEmail,
): express.Router {
  const router = express.Router();

  async function callerEmail(req: Request): Promise<string | undefined> {
    const userId = req.toolAuth?.userId;
    if (!userId) return undefined;
    try {
      return await resolveUserEmail(userId);
    } catch {
      return undefined;
    }
  }

  router.get('/agent/all-tools', manualAuth, async (req, res) => {
    try {
      const email = await callerEmail(req);
      // Default remote-safe: exclude local-only manuals unless the caller (a locally
      // installed MCP server) explicitly opts in with `?remote=false`.
      const remoteOnly = req.query.remote !== 'false';
      const userManuals = email ? await toolManualService.toManualCallTemplates(email, { remoteOnly }) : [];
      const manuals: CallTemplate[] = [kbManualTemplate(), ...userManuals];
      res.json({ manuals });
    } catch (err) {
      console.error('[tool-manuals] all-tools failed:', err instanceof Error ? err.message : err);
      res.status(500).json({ error: 'Failed to list tools' });
    }
  });

  router.get('/tools/:slug/manual', manualAuth, async (req, res) => {
    try {
      const email = await callerEmail(req);
      if (!email) return void res.status(403).json({ error: 'Forbidden' });
      const slug = Array.isArray(req.params.slug) ? req.params.slug[0] : req.params.slug;
      const manual = await toolManualService.resolveInlineManual(email, String(slug));
      if (!manual) return void res.status(404).json({ error: 'Not found' });
      res.json(manual);
    } catch (err) {
      console.error('[tool-manuals] manual resolve failed:', err instanceof Error ? err.message : err);
      res.status(500).json({ error: 'Failed to resolve manual' });
    }
  });

  return router;
}

/**
 * Browser-facing tool-manual routes (mounted under the JWT auth middleware):
 *   GET  /tools           — the caller's accessible `.tool` manuals (summaries).
 *   POST /tools/preview    — validate a draft `.tool` for the renderer.
 *   GET  /tools/:slug      — one readable manual with description + capabilities
 *                            (the tool page). Registered LAST so no future
 *                            literal sibling is shadowed by the param segment;
 *                            `preview` is POST-only, so it never collides.
 */
export function createToolManualsBrowserRoutes(toolManualService: IToolManualService): express.Router {
  const router = express.Router();

  router.get('/tools', async (req, res) => {
    const email = req.userEmail;
    if (!email) return void res.status(401).json({ error: 'Not authenticated' });
    try {
      res.json({ tools: await toolManualService.listAccessible(email) });
    } catch (err) {
      console.error('[tool-manuals] list failed:', err);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  router.post('/tools/preview', async (req, res) => {
    const email = req.userEmail;
    if (!email) return void res.status(401).json({ error: 'Not authenticated' });
    const content = typeof req.body?.content === 'string' ? req.body.content : '';
    res.json(await toolManualService.preview(content));
  });

  router.get('/tools/:slug', async (req, res) => {
    const email = req.userEmail;
    if (!email) return void res.status(401).json({ error: 'Not authenticated' });
    try {
      // `getDetail` returns null for BOTH "no such slug" and "you can't read it",
      // and this route keeps them indistinguishable: a distinct 403 would confirm
      // the existence of a tool the caller isn't allowed to know about. Same
      // fail-closed posture as the agent-facing `/tools/:slug/manual`.
      const tool = await toolManualService.getDetail(email, String(req.params.slug));
      if (!tool) return void res.status(404).json({ error: 'Not found' });
      res.json({ tool });
    } catch (err) {
      console.error('[tool-manuals] detail failed:', err);
      res.status(500).json({ error: 'Failed to load tool' });
    }
  });

  return router;
}
