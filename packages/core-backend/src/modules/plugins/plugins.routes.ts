import express from 'express';
import { logger } from '../../shared/logging.js';

const log = logger('plugins');
import '../auth/auth.middleware.js'; // Express Request.userId / userEmail augmentation
import {
  joinBranchFor,
  type AuthUser,
  type ChangeRequest,
  type ChangeRequestState,
  type IWorkflowService,
} from '@bevel-software/platform-shared';
import type { IAccessControl } from '../access/access-control.interface.js';
import { WorkflowDomainError } from '../../shared/domain-errors.js';
import { domainErrorBody } from '../../shared/http-errors.js';
import { pluginsWorkspaceId, pluginFolderBelowRoot } from './plugins.service.js';
import { PluginProvisionError, type PluginProvisionService } from './plugin-provision.service.js';
import { PluginLinkError, type PluginLinksService } from './plugin-links.service.js';
import { PluginRenameError, type PluginRenameService } from './plugin-rename.service.js';
import type { JoinRequestsService } from './join-requests.service.js';
import type { PluginJoinRequestJobs } from './join-request-jobs.service.js';
import type { JoinRequestRecord } from './join-request-records.store.js';
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
 *   POST   /api/plugins/:name/join-request         → { ok, state, number }  (records it)
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
 * A join request is a recorded row plus the change request the row's
 * background job opens — a branch that edits the plugin's `access.md`. The
 * row exists so the click can be answered before any git runs; what managers
 * see is the change request, unchanged.
 *
 * Managers do NOT merge it: they read its individual proposals
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

export function createPluginsRoutes(
  pluginIndex: IPluginIndexService,
  accessControl: IAccessControl,
  workflow: IWorkflowService,
  joinRequests: JoinRequestsService,
  /**
   * Where a join request is RECORDED, and what finishes it afterwards. The
   * subscribe endpoint writes the row and answers; the git work runs against
   * it after the answer (see `PluginJoinRequestJobs`) — which is why this
   * router no longer takes a workspace service or the KB directory name at
   * all, having no file of its own left to write.
   */
  joinRequestJobs: PluginJoinRequestJobs,
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
  /** A plugin folder's path BELOW the plugins root — see `pluginFolderBelowRoot`. */
  const folderBelowRoot = pluginFolderBelowRoot;
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
        log.warn(`join-request lookup failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      // What the caller has RECORDED — true the moment the subscribe call is
      // answered, which is the whole point: a reload while the git work is
      // still running must still show the Requested card, and the change
      // request the line above looks for may not exist yet. Degrades the same
      // way, to what the change requests alone can say.
      let recorded = new Map<string, JoinRequestRecord>();
      try {
        recorded = new Map(
          (await joinRequestJobs.recordsFor(email)).map((r) => [r.pluginKey, r]),
        );
      } catch (err) {
        log.warn(`recorded join requests unavailable: ${err instanceof Error ? err.message : String(err)}`);
      }
      // Whether the change request each `opened` record names still stands —
      // from the request's own row, because the listing above is open-only
      // and cached, so a declined request is merely absent from it. Null when
      // the rows could not be read: an `opened` record then keeps the benefit
      // of the doubt, since the alternative is a button over a request that
      // may well still be standing.
      let standing: Map<number, ChangeRequestState> | null = null;
      try {
        standing = await joinRequestJobs.changeRequestStates(
          [...recorded.values()].flatMap((r) =>
            r.status === 'opened' && r.changeRequestNumber !== null ? [r.changeRequestNumber] : [],
          ),
        );
      } catch (err) {
        log.warn(`join request states unavailable: ${err instanceof Error ? err.message : String(err)}`);
      }
      const stillOpen = (record: JoinRequestRecord): boolean =>
        standing === null ||
        (record.changeRequestNumber !== null && standing.get(record.changeRequestNumber) === 'open');

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
        const joinCr = member ? null : openJoinCr(mine, email, joinKeyOf(g));
        const record = member ? undefined : recorded.get(joinKeyOf(g));
        // A record that FAILED is not a request: the git work refused, so the
        // page owes the person the button back and the reason. A `pending`
        // one is, whether or not its change request has appeared yet. An
        // `opened` one is a request only for as long as the change request it
        // names is still open — once a manager declines it, or it is settled
        // and the access later taken back, the ask is over and the person may
        // make it again, exactly as they could when the change request was
        // the only record. The request's own row decides that (see
        // `standing`), never the open-only listing.
        const requested =
          record?.status === 'pending' ||
          (record?.status === 'opened' && stillOpen(record)) ||
          joinCr !== null;
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
          hasRequested: requested,
          requestNumber: requested ? (record?.changeRequestNumber ?? joinCr?.number ?? null) : null,
          requestFailure: requested
            ? null
            : (record?.status === 'failed' ? (record.failureReason ?? 'it could not be completed') : null),
        });
      }
      res.json({ plugins });
    } catch (err) {
      log.error('failed to list plugins:', { err });
      res.status(500).json({ error: 'Failed to list plugins' });
    }
  });

  /**
   * RECORD the caller's ask, and answer.
   *
   * What it does not do is any git, which is the change: the endpoint used to
   * create the branch, clone the plugins repository for it, splice the grant,
   * commit, push and open the change request before replying, and the first
   * ask from a person is a full clone — many seconds during which the button
   * only greyed out. So the gates below stay exactly as they were (discovery
   * fail-closed, membership 409) and what follows them is one row and a
   * reply; `PluginJoinRequestJobs` finishes the request afterwards and the
   * plugin listing reports it as requested from the row in the meantime.
   *
   * Still idempotent, and now by the ROW rather than by the branch name: the
   * record is unique per (caller, plugin), so two tabs and two clicks record
   * one request and open one change request. A record that failed is revived
   * by the next ask, so a retry continues it instead of starting a second one.
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
      // A record whose change request has since been declined or settled is
      // an ask that was answered; this click is a new one, and the row goes
      // back to `pending` for it. Costs one read of that request's row, on
      // that path only — a first ask, and a retry after a failure, are still
      // one statement.
      const record = await joinRequestJobs.reviveIfAnswered(
        await joinRequestJobs.record(user, joinKeyOf(plugin)),
      );
      // `number` stays in the answer for a caller that already had a change
      // request; it is null while the git work has yet to open one, and the
      // `state` is what says which.
      res.json({ ok: true, state: record.status, number: record.changeRequestNumber });
      // AFTER the answer, deliberately, and not awaited: the response is
      // already on the wire, and the job records its own outcome on the row.
      void joinRequestJobs.start(record);
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
