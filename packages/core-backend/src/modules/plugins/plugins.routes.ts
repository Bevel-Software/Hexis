import express from 'express';
import { logger } from '../../shared/logging.js';

const log = logger('plugins');
import '../auth/auth.middleware.js'; // Express Request.userId / userEmail augmentation
import {
  type AuthUser,
  type ChangeRequest,
  type IWorkflowService,
} from '@bevel-software/platform-shared';
import type { IAccessControl } from '../access/access-control.interface.js';
import { WorkflowDomainError } from '../../shared/domain-errors.js';
import { domainErrorBody } from '../../shared/http-errors.js';
import { pluginsWorkspaceId } from './plugins.service.js';
import { PluginProvisionError, type PluginProvisionService } from './plugin-provision.service.js';
import { PluginLinkError, type PluginLinksService } from './plugin-links.service.js';
import { PluginRenameError, type PluginRenameService } from './plugin-rename.service.js';
import type { JoinRequestsService } from './join-requests.service.js';
import {
  openJoinCrFor,
  type JoinRequestRecord,
  type PluginJoinRequestsQueue,
} from './join-request-queue.service.js';
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
 *   POST   /api/plugins/:name/join-request         → { ok, state, number } (records it)
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
 * after a grant. Nothing about the MANAGER-facing lifecycle is stored; it is
 * derived from two copies of one file.
 *
 * What IS stored is the moment before that change request exists. Asking to
 * join records a row and answers; the branch, the clone, the commit, the push
 * and the change request run afterwards in `PluginJoinRequestsQueue`. The
 * record is what lets the index answer "requested" during that window, what
 * survives a restart, and what a retry retries — see `askedState` for how the
 * two sources reconcile.
 *
 * Auth gating is explicit and uniform: `authMiddleware` at the mount, PLUS a
 * `req.userEmail` check in every handler (the skills-routes pattern) so a
 * middleware change can never silently un-gate one. Nothing here is reachable
 * with an agent connection key or a manual-auth bearer.
 */
/**
 * The two doors through which plugin folders come to exist — ONE
 * implementation each, for the app and for agents alike:
 *
 *  - `POST /plugins` `{ name, parent? }` — a shared plugin. Any authenticated
 *    user may create one; that is the product model (making a plugin makes
 *    you the one who runs it), and the seeded access.md immediately fences
 *    the new folder off from everyone else. `parent` is a grouping folder
 *    below the plugins root to make it in. See `PluginProvisionService` for
 *    why this is an endpoint and not a write path.
 *  - `POST /plugins/personal` — the caller's own space, ensured (idempotent).
 *    The UI calls it lazily before the first personal-skill write; an agent
 *    calls it to learn where to put a person's skills.
 *
 * Mounted apart from the other plugin routes, behind a gate that admits an
 * agent's connection key as well as a session (see `keyOrSessionAuth`):
 * the `create_plugin` and `my_plugin` tools are UTCP descriptions of these
 * very endpoints, not a second set. `resolveUser` reads the identity either
 * gate established.
 */
export function createPluginCreationRoutes(
  provision: Pick<PluginProvisionService, 'createPlugin' | 'ensurePersonalPlugin'>,
  resolveUser: (req: express.Request) => Promise<AuthUser | null>,
): express.Router {
  const router = express.Router();

  router.post('/plugins', async (req, res) => {
    const user = await resolveUser(req);
    if (!user) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    // `req.body` is undefined when no JSON body was sent at all — that is a
    // 400, not a destructuring crash.
    const { name, parent } = (req.body ?? {}) as { name?: string; parent?: unknown };
    if (typeof name !== 'string') {
      res.status(400).json({ error: 'name is required in body' });
      return;
    }
    // `parent`: a grouping folder below the plugins root to create in
    // (`Teams`, `Teams/EU`); absent or empty means the root. Validated by
    // the service, which owns every rule about where a plugin may go.
    if (parent !== undefined && typeof parent !== 'string') {
      res.status(400).json({ error: 'parent must be a folder path below the plugins root' });
      return;
    }
    try {
      const result = await provision.createPlugin(user, name, parent);
      res.status(201).json(result);
    } catch (err) {
      if (err instanceof PluginProvisionError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      log.error('create failed:', { err });
      res.status(500).json({ error: 'Failed to create the plugin' });
    }
  });

  router.post('/plugins/personal', async (req, res) => {
    const user = await resolveUser(req);
    if (!user) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    try {
      res.json(await provision.ensurePersonalPlugin(user));
    } catch (err) {
      // The service's own refusals keep their status — a 503 for incomplete
      // discovery tells the caller to try again, which a 500 would not.
      if (err instanceof PluginProvisionError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      log.error('personal-folder ensure failed:', { err });
      res.status(500).json({ error: 'Failed to prepare your personal folder' });
    }
  });

  return router;
}

/**
 * What the index tells a non-member about their own request for one plugin.
 *
 * Two sources, deliberately: the RECORD (which exists from the instant the
 * click was answered, before any git work) and the caller's open join change
 * request (which is what `hasRequested` was read from before records existed,
 * and is still the truth about whether managers have a request in front of
 * them). Reconciling them is three cases:
 *
 *   pending  the git work has not opened the change request yet — requested,
 *            on the record's word alone. This is what makes a reload one
 *            second after the click still show the "Requested" card.
 *   opened   the change request exists, so IT decides: a manager who granted
 *            or rejected it settled the request, and the plugin must offer
 *            the button again exactly as it did before this table existed.
 *            A record with no open change request left behind it is retired,
 *            lazily, by whoever noticed — so the next click records a fresh
 *            request rather than reusing a settled one.
 *   failed   not requested, and the page says why, so the person can retry.
 *            The next click reuses this same record.
 *
 * A record that is absent entirely falls back to the change request alone —
 * every request made before this table existed still reads correctly.
 */
function askedState(
  record: JoinRequestRecord | null,
  joinCr: ChangeRequest | null,
): { hasRequested: boolean; requestNumber: number | null; requestFailure: string | null; retire?: string } {
  if (!record) {
    return { hasRequested: joinCr !== null, requestNumber: joinCr?.number ?? null, requestFailure: null };
  }
  if (record.status === 'pending') {
    return { hasRequested: true, requestNumber: record.changeRequestNumber, requestFailure: null };
  }
  if (record.status === 'failed') {
    return {
      // An open change request outranks a failed record: the request did
      // reach the managers, whatever the record's last attempt thought.
      hasRequested: joinCr !== null,
      requestNumber: joinCr?.number ?? null,
      requestFailure: joinCr !== null ? null : record.failureReason,
    };
  }
  return {
    hasRequested: joinCr !== null,
    requestNumber: joinCr?.number ?? record.changeRequestNumber,
    requestFailure: null,
    retire: joinCr === null ? record.id : undefined,
  };
}

export function createPluginsRoutes(
  pluginIndex: IPluginIndexService,
  accessControl: IAccessControl,
  workflow: IWorkflowService,
  joinRequests: JoinRequestsService,
  /**
   * Where a click is RECORDED, and where the branch/clone/commit/push/change
   * request that follows it runs — after this route has answered. See
   * `PluginJoinRequestsQueue`.
   */
  joinQueue: PluginJoinRequestsQueue,
  provision: PluginProvisionService,
  resolveUser: (req: express.Request) => Promise<AuthUser | null>,
  /** Optional: a host without the link machinery simply has no link routes. */
  links?: PluginLinksService,
  /** Optional: a host without it has no rename route. */
  rename?: PluginRenameService,
): express.Router {
  const router = express.Router();

  /**
   * Rename a plugin — its identifier, its display name, or both. The
   * MANAGER's verb (write on the folder's access.md, the gate linking uses).
   * An identifier change rewrites every grant naming the old identifier in
   * the same commit; see `PluginRenameService`.
   *
   *   PATCH /api/plugins/:name  { name?, displayName? }  → { name, displayName, rewritten }
   */
  if (rename) {
    router.patch('/plugins/:name', async (req, res) => {
      if (!req.userEmail) {
        res.status(401).json({ error: 'Unauthenticated' });
        return;
      }
      const user = await resolveUser(req);
      if (!user) {
        res.status(401).json({ error: 'Unauthenticated' });
        return;
      }
      const body = (req.body ?? {}) as { name?: unknown; displayName?: unknown };
      try {
        res.json(await rename.rename(user, String(req.params.name), { name: body.name, displayName: body.displayName }));
      } catch (err) {
        if (err instanceof PluginRenameError) {
          res.status(err.status).json({ error: err.message, ...err.payload });
          return;
        }
        if (err instanceof WorkflowDomainError) {
          res.status(err.status).json(domainErrorBody(err));
          return;
        }
        log.error('rename failed:', { err });
        res.status(500).json({ error: 'Failed to rename the plugin' });
      }
    });
  }

  /**
   * Linking shared skills — see `PluginLinksService` for the two-sided write.
   *
   *   POST   /api/plugins/:name/links          { skillPath }  → { root, skills }
   *   DELETE /api/plugins/:name/links?skillPath=              → { root, revoked }
   *   POST   /api/plugins/:name/links/repair   { skillPath }  → { root }
   *
   * Refusals carry a `kind` the UI branches on — `needs-skill-write` (409) is
   * the one that becomes "request write access".
   */
  if (links) {
    const linkOp = async (
      req: express.Request,
      res: express.Response,
      op: (user: AuthUser, plugin: string, skillPath: string) => Promise<unknown>,
      skillPathOf: (req: express.Request) => unknown,
    ) => {
      if (!req.userEmail) {
        res.status(401).json({ error: 'Unauthenticated' });
        return;
      }
      const user = await resolveUser(req);
      if (!user) {
        res.status(401).json({ error: 'Unauthenticated' });
        return;
      }
      const skillPath = skillPathOf(req);
      if (typeof skillPath !== 'string' || !skillPath.trim()) {
        res.status(400).json({ error: 'skillPath is required' });
        return;
      }
      try {
        res.json(await op(user, String(req.params.name), skillPath));
      } catch (err) {
        if (err instanceof PluginLinkError) {
          res.status(err.status).json({ error: err.message, ...err.payload });
          return;
        }
        if (err instanceof WorkflowDomainError) {
          res.status(err.status).json(domainErrorBody(err));
          return;
        }
        log.error('link operation failed:', { err });
        res.status(500).json({ error: 'Failed to update the plugin\'s links' });
      }
    };
    const bodyPath = (req: express.Request) => ((req.body ?? {}) as { skillPath?: unknown }).skillPath;
    router.post('/plugins/:name/links', (req, res) => linkOp(req, res, (u, p, s) => links.link(u, p, s), bodyPath));
    router.post('/plugins/:name/links/repair', (req, res) =>
      linkOp(req, res, (u, p, s) => links.repair(u, p, s), bodyPath),
    );
    router.delete('/plugins/:name/links', (req, res) =>
      linkOp(req, res, (u, p, s) => links.unlink(u, p, s), (r) => r.query.skillPath),
    );
  }

  /** The folder-chain probe for MEMBERSHIP — the folder itself. */
  const memberProbe = (folder: string) => folder;
  /** The FILE probe for discovery/management — the folder's access.md. */
  const accessMdOf = (folder: string) => `${folder}/access.md`;
  /** A plugin folder's path BELOW the plugins root: `GTM`, or `teams/deep`. */
  const folderBelowRoot = (folder: string) => folder.slice(folder.indexOf('/') + 1);
  /**
   * What a join request is keyed by: the plugin's primary FOLDER path below
   * the root, not its identity. The request writes into that folder's rules;
   * a top-level folder keys exactly as every join branch already on a remote
   * was cut (its name), a nested one by its whole path, so two plugins whose
   * folders share a basename never share a branch; and a rename of the
   * identity moves no folder, so it orphans no open request.
   */
  const joinKeyOf = (g: PluginCatalogEntry) => folderBelowRoot(g.folders[0]);

  const probesFor = (plugins: PluginCatalogEntry[]): string[] => [
    ...new Set(plugins.flatMap((g) => g.folders.flatMap((f) => [memberProbe(f), accessMdOf(f)]))),
  ];

  /** The caller's open join CR for `plugin`, or null. */
  const openJoinCr = (mine: ChangeRequest[], email: string, plugin: string): ChangeRequest | null =>
    openJoinCrFor(mine, email, plugin);

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
        log.warn(`join-request lookup failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      // The caller's RECORDED requests, keyed by join key. A record exists
      // from the moment the click was answered, which is what lets a reload
      // one second later still show the "Requested" card — the change request
      // it will become may not exist yet. Degrades the same way the CR
      // listing above does: a database hiccup must not empty the plugin list.
      let records = new Map<string, JoinRequestRecord>();
      try {
        records = await joinQueue.byRequester(email);
      } catch (err) {
        log.warn(`join-record lookup failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      const plugins: PluginSummary[] = [];
      /** Ids of records this listing found settled — retired after the loop. */
      const retire: string[] = [];
      for (const g of catalog) {
        const member = any(readable, g, memberProbe);
        const manager = any(writable, g, accessMdOf);
        // The FOLDER verdict, owner-lists-only — the delete gate, mirrored
        // here so the UI shows the verb to exactly the people the DELETE
        // route will let through.
        const owner = any(owned, g, memberProbe);
        const discoverable = member || any(readable, g, accessMdOf);
        if (!member && !manager && !discoverable) continue; // absent — fail closed
        const joinCr = member ? null : openJoinCr(mine, email, joinKeyOf(g));
        const asked = member ? null : askedState(records.get(joinKeyOf(g)) ?? null, joinCr);
        plugins.push({
          name: g.name,
          displayName: g.displayName,
          folders: g.folders,
          linkedRoots: g.linkedRoots,
          canRead: member,
          canWrite: manager,
          isOwner: owner,
          linksAreManaged: g.linksAreManaged,
          skillCount: g.skillCount,
          toolCount: g.toolCount,
          brokenLinks: g.brokenLinks,
          owners: g.owners,
          writers: g.writers,
          readers: g.readers,
          isPrivate: g.isPrivate,
          warnings: g.warnings,
          hasRequested: asked?.hasRequested ?? false,
          requestNumber: asked?.requestNumber ?? null,
          requestFailure: asked?.requestFailure ?? null,
        });
        if (asked?.retire) retire.push(asked.retire);
      }
      // Lazily, after the answer is assembled: records whose change request
      // is no longer open. See `askedState`.
      for (const id of retire) {
        await joinQueue.retire(id).catch((err) => {
          log.warn(`could not retire a settled join record: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
      res.json({ plugins });
    } catch (err) {
      log.error('failed to list plugins:', { err });
      res.status(500).json({ error: 'Failed to list plugins' });
    }
  });

  /**
   * RECORD the caller's request to join, and answer. Nothing git happens
   * here: `PluginJoinRequestsQueue` cuts the branch, clones if it must,
   * splices the grant, commits, pushes and opens the change request after
   * this handler has replied. A first-ever request clones the whole plugins
   * repository, and waiting for that before answering is what made the button
   * look frozen.
   *
   * The gates are unchanged and still run BEFORE the record: an unknown and
   * an undiscoverable plugin answer identically (404), and a caller who can
   * already read the folder is told to reload (409) rather than asking for
   * what they have.
   *
   * Idempotent per (caller, plugin) on the queue's unique record, so two tabs
   * record one request and open one change request; a failed record is
   * retried rather than replaced. Every step the queue then runs is an
   * existing primitive — branch, splice, commit-and-push, open CR — so the
   * security story is exactly the workflow's: draft branches are ungated, and
   * the merge gate requires an approver who can write the touched access.md.
   */
  // `POST /plugins` and `POST /plugins/personal` — the creation doors — live
  // in `createPluginCreationRoutes` below, mounted behind a gate that admits
  // an agent's connection key as well as a session, since the same two
  // endpoints are what the `create_plugin` and `my_plugin` tools describe.

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
      // By identity — the manifest name the catalog keys on.
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
      // Provisioning works on FOLDERS (it created one); the identity only
      // found the plugin. The whole path below the root, so a nested plugin
      // is deleted where it is.
      await provision.deletePlugin(user, folderBelowRoot(plugin.folders[0]));
      pluginIndex.invalidate();
      res.json({ ok: true });
    } catch (err) {
      if (err instanceof PluginProvisionError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      log.error('delete failed:', { err });
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
      // By identity — the manifest name the catalog keys on.
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

      // RECORD, then answer. Everything git — branch, clone, splice, commit,
      // push, change request — happens after this line, in the queue. The
      // first request a person ever makes clones the plugins repository, and
      // doing that before answering is what made the button look frozen.
      const record = await joinQueue.request({
        user,
        pluginKey: joinKeyOf(plugin),
        pluginFolder: folder,
        pluginDisplayName: plugin.displayName,
      });
      // `number` is null until the change request exists. The page does not
      // wait for it: `state: 'pending'` is what turns the button into the
      // "Requested" card, and the index reports the plugin as requested from
      // the record itself from this moment on.
      res.json({ ok: true, state: record.status, number: record.changeRequestNumber });
    } catch (err) {
      if (err instanceof WorkflowDomainError) {
        res.status(err.status).json(domainErrorBody(err));
        return;
      }
      log.error('failed to open a join request:', { err });
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
        requests: await joinRequests.list(joinKeyOf(ctx.plugin), ctx.folder, crs, ctx.user),
      });
    } catch (err) {
      log.error('failed to list join requests:', { err });
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
      res.json({ closed: await joinRequests.reconcile(joinKeyOf(ctx.plugin), ctx.folder, cr, ctx.user) });
    } catch (err) {
      log.error('failed to reconcile a join request:', { err });
      res.status(500).json({ error: 'Failed to update the request' });
    }
  });

  return router;
}
