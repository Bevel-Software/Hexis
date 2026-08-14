import express, { type Request, type RequestHandler } from 'express';
import path from 'node:path';
import fs from 'node:fs/promises';
import AdmZip from 'adm-zip';
import { DEFAULT_BRANCH, PLUGINS_DIR } from '@bevel-software/platform-shared';
import { workspaceIdForBranch, type WorkspaceService } from '../workspace/workspace.service.js';
import type { IAccessControl } from '../access/access-control.interface.js';
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
  archiveDeps?: { workspaceService: WorkspaceService; accessControl: IAccessControl; kbDirName: string },
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

  /**
   * The whole plugin, byte-for-byte, as a zip — the materialization surface
   * for the local MCP server. `read_file` is the agent's READING tool (text,
   * one file at a time); this exists because a stdio server's plugin must
   * land on the user's disk exactly as it is, binaries included. Access is
   * per-file and the caller's own: every entry is filtered through the same
   * read verdicts `list_files` uses, so a file the key cannot read is a file
   * that is not in the archive — not an error, an absence.
   */
  router.get('/agent/plugins/:folder/archive', manualAuth, async (req, res) => {
    if (!archiveDeps) return void res.status(404).json({ error: 'Not available' });
    try {
      const email = await callerEmail(req);
      if (!email) return void res.status(403).json({ error: 'Forbidden' });
      const folder = String(Array.isArray(req.params.folder) ? req.params.folder[0] : req.params.folder);
      if (!folder || folder === '.' || folder === '..' || /[/\\]/.test(folder)) {
        return void res.status(422).json({ error: 'Not a plugin folder name' });
      }
      const { workspaceService, accessControl, kbDirName } = archiveDeps;
      const wsId = workspaceIdForBranch(DEFAULT_BRANCH);
      await workspaceService.getOrCreateForBranch(DEFAULT_BRANCH);
      const wsDir = await workspaceService.getWorkspacePath(wsId);
      const pluginDir = path.join(wsDir, kbDirName, PLUGINS_DIR, folder);
      const pluginReal = await fs.realpath(pluginDir).catch(() => null);
      if (pluginReal === null) return void res.status(404).json({ error: 'Not found' });
      const rels: string[] = [];
      const walk = async (dir: string, rel: string): Promise<void> => {
        let entries;
        try {
          entries = await fs.readdir(dir, { withFileTypes: true });
        } catch (err) {
          // Only an absent directory is a non-event; anything else (EACCES,
          // EIO) silently missing from the archive would hand the client an
          // incomplete plugin stamped as success.
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
          throw err;
        }
        for (const e of entries) {
          if (e.name === '.git') continue;
          const childRel = rel ? `${rel}/${e.name}` : e.name;
          const abs = path.join(dir, e.name);
          if (e.isDirectory()) await walk(abs, childRel);
          else if (e.isFile()) rels.push(childRel);
          else if (e.isSymbolicLink()) {
            // A symlink materializes as its target CONTENT — but only when the
            // resolved target stays inside the plugin. A link reaching outside
            // would zip content the per-file ACL below never judged (verdicts
            // key on the plugin-relative path, not the target), so it is
            // dropped, loudly rather than silently.
            const real = await fs.realpath(abs).catch(() => null);
            if (real === null) continue;
            const relToRoot = path.relative(pluginReal, real);
            if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) {
              console.warn(`[tool-manuals] archive of "${folder}": symlink ${childRel} points outside the plugin — skipped.`);
              continue;
            }
            const st = await fs.stat(abs).catch(() => null);
            if (st?.isDirectory()) await walk(abs, childRel);
            else if (st?.isFile()) rels.push(childRel);
          }
        }
      };
      await walk(pluginDir, '');
      if (rels.length === 0) return void res.status(404).json({ error: 'Not found' });
      const verdicts = await accessControl.canReadBatch(
        wsId,
        email,
        rels.map((r) => `${PLUGINS_DIR}/${folder}/${r}`),
      );
      const zip = new AdmZip();
      let included = 0;
      let bytes = 0;
      // The zip is built in memory; without a ceiling one plugin full of large
      // assets is a backend OOM any key holder can trigger.
      const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
      for (const rel of rels) {
        // Fail closed, per file — only an explicit `true` verdict is included.
        if (verdicts.get(`${PLUGINS_DIR}/${folder}/${rel}`) !== true) continue;
        const data = await fs.readFile(path.join(pluginDir, ...rel.split('/')));
        bytes += data.length;
        if (bytes > MAX_ARCHIVE_BYTES) {
          return void res.status(413).json({
            error: `Plugin "${folder}" exceeds the ${MAX_ARCHIVE_BYTES / (1024 * 1024)}MB archive limit.`,
          });
        }
        zip.addFile(rel, data);
        included += 1;
      }
      // An all-filtered plugin looks exactly like an absent one — a 404 must
      // not confirm to a keyless caller that the folder exists.
      if (included === 0) return void res.status(404).json({ error: 'Not found' });
      res.setHeader('Content-Type', 'application/zip');
      res.send(zip.toBuffer());
    } catch (err) {
      console.error('[tool-manuals] plugin archive failed:', err instanceof Error ? err.message : err);
      res.status(500).json({ error: 'Failed to archive plugin' });
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
