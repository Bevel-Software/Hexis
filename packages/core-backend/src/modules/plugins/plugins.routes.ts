import express from 'express';
import '../auth/auth.middleware.js'; // Express Request.userId / userEmail augmentation
import {
  DEFAULT_BRANCH,
  joinBranchFor,
  type AuthUser,
  type ChangeRequest,
  type IWorkflowService,
} from '@bevel-software/platform-shared';
import type { IAccessControl } from '../access/access-control.interface.js';
import { spliceGrant } from '../access/access-splice.js';
import { WorkflowDomainError } from '../workflow/workflow.errors.js';
import type { WorkspaceService } from '../workspace/workspace.service.js';
import { pluginsWorkspaceId } from './plugins.service.js';
import { PluginProvisionError, type PluginProvisionService } from './plugin-provision.service.js';
import type { JoinRequestsService } from './join-requests.service.js';
import type {
  PluginCatalogEntry,
  PluginSummary,
  IPluginIndexService,
} from './plugins.contract.js';

/**
 * Browser-facing (JWT) plugin routes, mounted behind `authMiddleware`:
 *
 *   GET    /api/plugins                            → { plugins: PluginSummary[] }
 *   DELETE /api/plugins/:name                      → { ok }          (owners)
 *   POST   /api/plugins/:name/join-request         → { ok, number }  (opens a CR)
 *   GET    /api/plugins/:name/join-requests        → { requests }    (managers)
 *   POST   /api/plugins/:name/join-requests/:n/reconcile → { closed }
 *
 * Enumeration is three verdicts per (caller, plugin), all of them ordinary
 * access resolution — no special cases, no side tables:
 *
 *   member       canRead on the plugin FOLDER
 *   manager      canWrite on the folder's access.md (admin-rescued)
 *   discoverable canRead on the access.md FILE — in the body-governed format
 *                its own `read: everyone` frontmatter grants this
 *
 * All three false ⇒ the plugin is absent from the response entirely.
 *
 * A join request is a plain change request whose branch edits the plugin's
 * `access.md`. Managers do NOT merge it: they read its individual proposals
 * (see `join-proposals.ts`), grant the ones they accept through the ordinary
 * access path, and the request retires itself once its rules are a subset of
 * the default branch's — reconciled here, lazily on listing and eagerly right
 * after a grant. Nothing about the lifecycle is stored; it is derived from
 * two copies of one file.
 *
 * Auth gating is explicit and uniform: `authMiddleware` at the mount, PLUS a
 * `req.userEmail` check in every handler (the skills-routes pattern) so a
 * middleware change can never silently un-gate one. Nothing here is reachable
 * with an agent connection key or a manual-auth bearer.
 */
export function createPluginsRoutes(
  pluginIndex: IPluginIndexService,
  accessControl: IAccessControl,
  workflow: IWorkflowService,
  workspaceService: WorkspaceService,
  joinRequests: JoinRequestsService,
  provision: PluginProvisionService,
  kbDirName: string,
  resolveUser: (req: express.Request) => Promise<AuthUser | null>,
  /**
   * Public-demo lockdown (see `CoreConfig.publicDemo`): when true, both
   * provisioning doors refuse. They are the only writes a visitor can reach —
   * everything else is already ACL-denied — and on a shared demo a visitor's
   * folder is where one visitor could plant tools for another visitor's
   * agent to follow.
   */
  publicDemo = false,
): express.Router {
  const router = express.Router();

  /** Answers for both provisioning doors while the public demo is locked. */
  const refuseInDemo = (res: express.Response): boolean => {
    if (!publicDemo) return false;
    res.status(403).json({
      error:
        'This shared demo is read-only: creating plugins and personal skills is ' +
        'disabled so no visitor can change what other visitors (and their agents) see. ' +
        'Bevel is open source — self-host it from ' +
        'https://github.com/Bevel-Software/Hexis and your own ' +
        'deployment has no such limit.',
      kind: 'public-demo',
    });
    return true;
  };

  /** The folder-chain probe for MEMBERSHIP — the folder itself. */
  const memberProbe = (folder: string) => folder;
  /** The FILE probe for discovery/management — the folder's access.md. */
  const accessMdOf = (folder: string) => `${folder}/access.md`;

  const probesFor = (plugins: PluginCatalogEntry[]): string[] => [
    ...new Set(plugins.flatMap((g) => g.folders.flatMap((f) => [memberProbe(f), accessMdOf(f)]))),
  ];

  /** The caller's open join CR for `plugin`, or null. */
  const openJoinCr = (mine: ChangeRequest[], email: string, plugin: string): ChangeRequest | null =>
    mine.find((cr) => cr.state === 'open' && cr.branch === joinBranchFor(email, plugin)) ?? null;

  router.get('/plugins', async (req, res) => {
    const email = req.userEmail;
    if (!email) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    try {
      const catalog = await pluginIndex.catalog();
      if (catalog.length === 0) {
        res.json({ plugins: [] });
        return;
      }
      const wsId = pluginsWorkspaceId();
      const probes = probesFor(catalog);
      const [readable, writable, owned] = await Promise.all([
        accessControl.canReadBatch(wsId, email, probes),
        accessControl.canWriteBatch(wsId, email, probes),
        accessControl.canOwnerBatch(wsId, email, probes),
      ]);
      // Fail closed on every verdict: a path missing from the map is denied.
      const any = (map: Map<string, boolean>, g: PluginCatalogEntry, probe: (f: string) => string) =>
        g.folders.some((f) => map.get(probe(f)) === true);

      // The caller's own open join CRs — drives `hasRequested`. A CR-listing
      // hiccup must not take plugin enumeration down: degrade to "nothing
      // requested" and let the next load repair it.
      let mine: ChangeRequest[] = [];
      try {
        mine = await workflow.listChangeRequestsAuthoredBy(email);
      } catch (err) {
        console.warn(
          `[plugins] join-request lookup failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const plugins: PluginSummary[] = [];
      for (const g of catalog) {
        const member = any(readable, g, memberProbe);
        const manager = any(writable, g, accessMdOf);
        // The FOLDER verdict, owner-lists-only — the delete gate, mirrored
        // here so the UI shows the verb to exactly the people the DELETE
        // route will let through.
        const owner = any(owned, g, memberProbe);
        const discoverable = member || any(readable, g, accessMdOf);
        if (!member && !manager && !discoverable) continue; // absent — fail closed
        const joinCr = member ? null : openJoinCr(mine, email, g.name);
        plugins.push({
          name: g.name,
          folders: g.folders,
          canRead: member,
          canWrite: manager,
          isOwner: owner,
          skillCount: g.skillCount,
          toolCount: g.toolCount,
          owners: g.owners,
          writers: g.writers,
          readers: g.readers,
          hasRequested: joinCr !== null,
          requestNumber: joinCr?.number ?? null,
        });
      }
      res.json({ plugins });
    } catch (err) {
      console.error('[plugins] failed to list plugins:', err);
      res.status(500).json({ error: 'Failed to list plugins' });
    }
  });

  /**
   * Open (or return the existing) join change request for the caller.
   *
   * Idempotent via the deterministic branch name: a second click finds the
   * open CR and returns it. Every step is an existing primitive — branch,
   * splice, commit-and-push, open CR — so the security story is exactly the
   * workflow's: draft branches are ungated, and the merge gate requires an
   * approver who can write the touched access.md.
   */
  /**
   * Create a plugin — the ONE door through which `Plugins/<name>/` folders come
   * to exist. Any authenticated user may create one; that is the product
   * model (making a plugin makes you the one who runs it), and the seeded
   * access.md immediately fences the new folder off from everyone else. See
   * `PluginProvisionService` for why this is an endpoint and not a write path.
   */
  router.post('/plugins', async (req, res) => {
    if (refuseInDemo(res)) return;
    const user = await resolveUser(req);
    if (!user) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    // `req.body` is undefined when no JSON body was sent at all — that is a
    // 400, not a destructuring crash.
    const { name } = (req.body ?? {}) as { name?: string };
    if (typeof name !== 'string') {
      res.status(400).json({ error: 'name is required in body' });
      return;
    }
    try {
      const result = await provision.createPlugin(user, name);
      res.status(201).json(result);
    } catch (err) {
      if (err instanceof PluginProvisionError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      console.error('[plugins] create failed:', err);
      res.status(500).json({ error: 'Failed to create the plugin' });
    }
  });

  /**
   * Ensure the caller's personal folder (`Plugins/personal-<id>/`) exists —
   * idempotent; the UI calls it lazily right before the first personal-skill
   * write. Private by construction: its access.md names only the caller.
   */
  router.post('/plugins/personal', async (req, res) => {
    if (refuseInDemo(res)) return;
    const user = await resolveUser(req);
    if (!user) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    try {
      res.json(await provision.ensurePersonalPlugin(user));
    } catch (err) {
      console.error('[plugins] personal-folder ensure failed:', err);
      res.status(500).json({ error: 'Failed to prepare your personal folder' });
    }
  });

  /**
   * Delete a plugin — the OWNER's verb, and only theirs. Creating a plugin
   * makes you the one who runs it; deleting it is the other end of that same
   * promise, so the gate is the `owner` verdict on the folder (owner-lists
   * only, no admin rescue) — a manager who merely writes the access.md, and
   * an admin rescued into managing it, do not get it.
   *
   * Fail-closed like every other plugin surface: an unknown plugin and a plugin
   * the caller does not own answer IDENTICALLY, so probing the endpoint can
   * confirm nothing about what exists. The mechanism (park, one commit,
   * rollback on refusal) lives in `PluginProvisionService.deletePlugin`.
   */
  router.delete('/plugins/:name', async (req, res) => {
    const email = req.userEmail;
    if (!email) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    try {
      const user = await resolveUser(req);
      if (!user) {
        res.status(401).json({ error: 'Unauthenticated' });
        return;
      }
      // Case-sensitive, like `pluginOfPath` — the plugin name IS the folder name.
      const plugin = (await pluginIndex.catalog()).find((g) => g.name === req.params.name);
      const wsId = pluginsWorkspaceId();
      const ownerVerdicts = plugin
        ? await Promise.all(
            plugin.folders.map((f) => accessControl.canOwner(wsId, email, memberProbe(f))),
          )
        : [];
      if (!plugin || !ownerVerdicts.some((v) => v === true)) {
        res.status(404).json({ error: 'Unknown plugin', kind: 'unknown-plugin' });
        return;
      }
      await provision.deletePlugin(user, plugin.name);
      pluginIndex.invalidate();
      res.json({ ok: true });
    } catch (err) {
      if (err instanceof PluginProvisionError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      console.error('[plugins] delete failed:', err);
      res.status(500).json({ error: 'Failed to delete the plugin' });
    }
  });

  router.post('/plugins/:name/join-request', async (req, res) => {
    const email = req.userEmail;
    if (!email) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    try {
      const user = await resolveUser(req);
      if (!user) {
        res.status(401).json({ error: 'Unauthenticated' });
        return;
      }
      const catalog = await pluginIndex.catalog();
      // Case-sensitive, like `pluginOfPath` — the plugin name IS the folder name.
      const plugin = catalog.find((g) => g.name === req.params.name);
      const wsId = pluginsWorkspaceId();
      // Same ANY-folder shape `GET /plugins` resolves with, so a plugin can
      // never be listed as discoverable there and rejected as unknown here.
      const verdicts = plugin
        ? await accessControl.canReadBatch(
            wsId,
            email,
            plugin.folders.flatMap((f) => [memberProbe(f), accessMdOf(f)]),
          )
        : new Map<string, boolean>();
      const any = (probe: (f: string) => string) =>
        plugin?.folders.some((f) => verdicts.get(probe(f)) === true) ?? false;
      // Discovery gate, fail-closed: an unknown plugin and a plugin the caller
      // cannot discover answer IDENTICALLY, so probing can't confirm existence.
      if (!plugin || !any(accessMdOf)) {
        res.status(404).json({ error: 'Unknown plugin', kind: 'unknown-plugin' });
        return;
      }
      if (any(memberProbe)) {
        // Access landed between page load and click — reload, don't ask.
        res.status(409).json({ error: 'You can already read this plugin', kind: 'already-readable' });
        return;
      }
      // The grant is written to the plugin's primary folder — the one the
      // summary's `folders[0]` names and the banner's touched-path check
      // expects.
      const folder = plugin.folders[0];

      const branch = joinBranchFor(email, plugin.name);
      const existing = openJoinCr(await workflow.listChangeRequestsAuthoredBy(email), email, plugin.name);
      if (existing) {
        res.json({ ok: true, number: existing.number });
        return;
      }

      // A leftover branch from a rejected/withdrawn request is reused — the
      // grant commit is already on it and the splice below no-ops.
      try {
        await workflow.createBranch(pluginsWorkspaceId(), branch, DEFAULT_BRANCH);
      } catch {
        // exists (or raced) — proceed against it
      }
      const ws = await workspaceService.getOrCreateForBranch(branch);
      const accessPath = `${kbDirName}/${accessMdOf(folder)}`;
      const current = await workspaceService.readFile(ws.id, accessPath).catch(() => '');
      const spliced = spliceGrant(
        current,
        'read',
        { kind: 'user', email: user.email, displayName: user.name },
        { target: 'folder' },
      );
      if (spliced.changed) {
        await workspaceService.writeFile(ws.id, accessPath, spliced.text);
        await workflow.commitChanges(ws.id, user, `Request access to ${plugin.name}`);
      }
      const detail = await workflow.openChangeRequest(ws.id, user, {
        sourceBranch: branch,
        targetBranch: DEFAULT_BRANCH,
        title: `Join request: ${plugin.name}`,
        description:
          `${user.name} asked to join ${plugin.name}. A manager of the plugin accepts by ` +
          `granting the access this branch proposes; the request closes itself once ` +
          `every proposal has landed.`,
      });
      res.json({ ok: true, number: detail.number });
    } catch (err) {
      if (err instanceof WorkflowDomainError) {
        res.status(err.status).json({ error: err.message, ...(err.payload ?? {}) });
        return;
      }
      console.error('[plugins] failed to open a join request:', err);
      res.status(500).json({ error: 'Failed to request access' });
    }
  });

  /**
   * Resolve the caller as a MANAGER of `name` — the only role that may see or
   * settle its join requests. Returns the plugin's primary folder, or null
   * after answering the request.
   *
   * A non-manager gets an empty list rather than a 403 (the frontend asks
   * unconditionally, exactly as it does for every other plugin surface), and
   * an unknown plugin is indistinguishable from an unmanaged one.
   */
  async function requireManager(
    req: express.Request,
    res: express.Response,
    onDenied: () => void,
  ): Promise<{ plugin: PluginCatalogEntry; folder: string; user: AuthUser } | null> {
    const email = req.userEmail;
    if (!email) {
      res.status(401).json({ error: 'Unauthenticated' });
      return null;
    }
    const plugin = (await pluginIndex.catalog()).find((g) => g.name === req.params.name);
    if (!plugin) {
      onDenied();
      return null;
    }
    const writable = await accessControl.canWriteBatch(
      pluginsWorkspaceId(),
      email,
      plugin.folders.map(accessMdOf),
    );
    if (!plugin.folders.some((f) => writable.get(accessMdOf(f)) === true)) {
      onDenied();
      return null;
    }
    const user = await resolveUser(req);
    if (!user) {
      res.status(401).json({ error: 'Unauthenticated' });
      return null;
    }
    return { plugin, folder: plugin.folders[0], user };
  }

  router.get('/plugins/:name/join-requests', async (req, res) => {
    try {
      const ctx = await requireManager(req, res, () => res.json({ requests: [] }));
      if (!ctx) return;
      const crs = await workflow.listChangeRequests();
      res.json({
        requests: await joinRequests.list(ctx.plugin.name, ctx.folder, crs, ctx.user),
      });
    } catch (err) {
      console.error('[plugins] failed to list join requests:', err);
      res.status(500).json({ error: 'Failed to list join requests' });
    }
  });

  /**
   * Settle one request if its proposals have all landed on the default
   * branch. Called right after a grant so the banner updates in the same
   * round-trip; the listing does the same thing lazily, so skipping this (a
   * dropped response, a closed tab) only delays it.
   */
  router.post('/plugins/:name/join-requests/:number/reconcile', async (req, res) => {
    try {
      const ctx = await requireManager(req, res, () =>
        res.status(404).json({ error: 'Not found' }),
      );
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
      res.json({ closed: await joinRequests.reconcile(ctx.plugin.name, ctx.folder, cr, ctx.user) });
    } catch (err) {
      console.error('[plugins] failed to reconcile a join request:', err);
      res.status(500).json({ error: 'Failed to update the request' });
    }
  });

  return router;
}
