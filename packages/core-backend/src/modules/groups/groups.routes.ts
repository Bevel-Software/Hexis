import express from 'express';
import '../auth/auth.middleware.js'; // Express Request.userId / userEmail augmentation
import type { IAccessControl } from '../access/access-control.interface.js';
import type { AccessRequestsService } from './access-requests.service.js';
import { groupsWorkspaceId } from './groups.service.js';
import type {
  GroupAccessRequestEntry,
  GroupCatalogEntry,
  GroupPrincipals,
  GroupSummary,
  IGroupIndexService,
  ResolvedPrincipals,
} from './groups.contract.js';

/**
 * Browser-facing (JWT) group routes, mounted behind `authMiddleware`. Four
 * endpoints, all of them enumeration or Postgres writes — none of them touches
 * the knowledge base:
 *
 *   GET  /api/groups                              → { groups: GroupSummary[] }
 *   POST /api/groups/:name/access-requests        → { ok, hasRequested }
 *   GET  /api/groups/access-requests              → { requests: … }   (admin-filtered)
 *   POST /api/groups/access-requests/:id/dismiss  → { ok }
 *
 * Auth gating is explicit and uniform: `authMiddleware` at the mount, PLUS a
 * `req.userEmail` check in every handler (the skills-routes pattern) so a
 * middleware change can never silently un-gate one of them. Nothing here is
 * reachable with an agent connection key or a manual-auth bearer — locked-group
 * discovery is a browser surface.
 *
 * The per-caller verdicts (`canRead` / `canWrite`) come from ONE
 * `canReadBatch` + ONE `canWriteBatch` per request over `${folder}/access.md`
 * probes. That probe path is exactly the folder-chain readability every real
 * child inherits (root `access.md` → … → the folder's own), and it works
 * whether or not the file exists — a missing one reads as null own-entries and
 * the chain decides.
 */
export function createGroupsRoutes(
  groupIndex: IGroupIndexService,
  requests: AccessRequestsService,
  accessControl: IAccessControl,
  resolveUserName: (req: express.Request) => Promise<string>,
): express.Router {
  const router = express.Router();

  /** Every constituent folder's access probe, deduped. */
  const probesFor = (groups: GroupCatalogEntry[]): string[] => [
    ...new Set(groups.flatMap((g) => g.folders.map(accessProbe))),
  ];

  router.get('/groups', async (req, res) => {
    const email = req.userEmail;
    if (!email) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    try {
      const catalog = await groupIndex.catalog();
      if (catalog.length === 0) {
        res.json({ groups: [] });
        return;
      }
      const wsId = groupsWorkspaceId();
      const probes = probesFor(catalog);
      const [readable, writable] = await Promise.all([
        accessControl.canReadBatch(wsId, email, probes),
        accessControl.canWriteBatch(wsId, email, probes),
      ]);
      // Fail closed on both verdicts: a folder missing from the map is denied,
      // matching the KB's default-deny read model.
      const verdict = (map: Map<string, boolean>, g: GroupCatalogEntry) =>
        g.folders.some((f) => map.get(accessProbe(f)) === true);

      // A DB outage must not take discovery down with it — the Library still
      // enumerates, everyone just looks un-requested.
      let pending: { id: string; groupName: string }[] = [];
      try {
        pending = await requests.pendingByRequester(email);
      } catch (err) {
        console.warn(
          `[groups] pending-request lookup failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // Lazy fulfillment, requester side: a request whose group the caller can
      // now read has already been answered — granting read IS approving, so no
      // separate approve step exists to leave the row behind.
      const stillPending = new Set<string>();
      const fulfilled: string[] = [];
      for (const row of pending) {
        const group = catalog.find((g) => g.name === row.groupName);
        if (group && verdict(readable, group)) fulfilled.push(row.id);
        else stillPending.add(row.groupName);
      }
      await retire(requests, fulfilled);

      const groups: GroupSummary[] = catalog.map((g) => {
        const canRead = verdict(readable, g);
        return {
          name: g.name,
          folders: g.folders,
          canRead,
          canWrite: verdict(writable, g),
          skillCount: g.skillCount,
          toolCount: g.toolCount,
          owners: disclose(g.owners, canRead),
          writers: disclose(g.writers, canRead),
          readers: canRead ? { restricted: g.readers.restricted, ...disclose(g.readers, true) } : null,
          hasRequested: !canRead && stillPending.has(g.name),
        };
      });
      res.json({ groups });
    } catch (err) {
      console.error('[groups] failed to list groups:', err);
      res.status(500).json({ error: 'Failed to list groups' });
    }
  });

  router.post('/groups/:name/access-requests', async (req, res) => {
    const email = req.userEmail;
    if (!email) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    try {
      const catalog = await groupIndex.catalog();
      // Case-sensitive, like `groupOfPath` — the group name IS the folder name.
      const group = catalog.find((g) => g.name === req.params.name);
      if (!group) {
        res.status(404).json({ error: 'Unknown group', kind: 'unknown-group' });
        return;
      }
      const probes = group.folders.map(accessProbe);
      const readable = await accessControl.canReadBatch(groupsWorkspaceId(), email, probes);
      if (probes.some((p) => readable.get(p) === true)) {
        // Access landed between page load and click — the caller doesn't need
        // to ask, they need to reload.
        res.status(409).json({ error: 'You can already read this group', kind: 'already-readable' });
        return;
      }
      await requests.create(group.name, email, await resolveUserName(req));
      res.json({ ok: true, hasRequested: true });
    } catch (err) {
      console.error('[groups] failed to record an access request:', err);
      res.status(500).json({ error: 'Failed to request access' });
    }
  });

  router.get('/groups/access-requests', async (req, res) => {
    const email = req.userEmail;
    if (!email) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    try {
      const [catalog, rows] = await Promise.all([groupIndex.catalog(), requests.pendingAll()]);
      const byName = new Map(catalog.map((g) => [g.name, g]));
      // A row whose group folder no longer exists is hidden, not 500'd — it
      // stays pending in the DB, visible to an audit, invisible to the UI.
      const live = rows.filter((r) => byName.has(r.groupName));

      // Lazy fulfillment, admin side: one batch per DISTINCT requester (the
      // verdict is per person, so it can't share the caller's batch).
      const fulfilled: string[] = [];
      const stale = new Set<string>();
      const requesters = [...new Set(live.map((r) => r.requesterEmail))];
      const verdicts = await Promise.all(
        requesters.map(async (requester) => {
          const groups = live.filter((r) => r.requesterEmail === requester).map((r) => byName.get(r.groupName)!);
          return [
            requester,
            await accessControl.canReadBatch(groupsWorkspaceId(), requester, probesFor(groups)),
          ] as const;
        }),
      );
      const readableBy = new Map(verdicts);
      for (const row of live) {
        const group = byName.get(row.groupName)!;
        if (group.folders.some((f) => readableBy.get(row.requesterEmail)?.get(accessProbe(f)) === true)) {
          fulfilled.push(row.id);
          stale.add(row.id);
        }
      }
      await retire(requests, fulfilled);

      // Admin filter: a row is visible to whoever can write its group's
      // `access.md` — the same people who can act on it. Non-admins get an
      // empty list, never a 403, so the frontend can ask unconditionally.
      const open = live.filter((r) => !stale.has(r.id));
      const writable = await accessControl.canWriteBatch(
        groupsWorkspaceId(),
        email,
        probesFor(open.map((r) => byName.get(r.groupName)!)),
      );
      const visible: GroupAccessRequestEntry[] = open
        .filter((r) => byName.get(r.groupName)!.folders.some((f) => writable.get(accessProbe(f)) === true))
        .map((r) => ({
          id: r.id,
          group: r.groupName,
          requesterName: r.requesterName,
          requesterEmail: r.requesterEmail,
          createdAt: r.createdAt.toISOString(),
        }));
      res.json({ requests: visible });
    } catch (err) {
      console.error('[groups] failed to list access requests:', err);
      res.status(500).json({ error: 'Failed to list access requests' });
    }
  });

  router.post('/groups/access-requests/:id/dismiss', async (req, res) => {
    const email = req.userEmail;
    if (!email) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    try {
      const row = await requests.getPending(req.params.id);
      if (!row) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      const group = (await groupIndex.catalog()).find((g) => g.name === row.groupName);
      // No folder ⇒ nobody can write its `access.md` ⇒ nobody is its admin.
      // Fail closed rather than letting a deleted group become dismissable by
      // anyone who can guess the row id.
      const writable = group
        ? await accessControl.canWriteBatch(groupsWorkspaceId(), email, group.folders.map(accessProbe))
        : new Map<string, boolean>();
      if (!group?.folders.some((f) => writable.get(accessProbe(f)) === true)) {
        res.status(403).json({ error: 'Not allowed' });
        return;
      }
      // Raced with another dismiss or a lazy fulfillment — the row is settled,
      // which is indistinguishable from never having been pending.
      if (!(await requests.dismiss(row.id, email))) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      console.error('[groups] failed to dismiss an access request:', err);
      res.status(500).json({ error: 'Failed to dismiss the request' });
    }
  });

  return router;
}

/** The folder-chain readability probe for a group folder. */
function accessProbe(folder: string): string {
  return `${folder}/access.md`;
}

/**
 * Emails ride out only to people who can already read the group — the same
 * disclosure posture as `GET /workspace/:id/access`. A non-reader still gets
 * the display names (they need to know who to ask); nulling the email keeps
 * the endpoint from becoming an address-book for every group in the workspace.
 */
function disclose(principals: ResolvedPrincipals, canRead: boolean): GroupPrincipals {
  return {
    roles: [...principals.roles],
    users: principals.users.map((u) => ({ name: u.name, email: canRead ? u.email : null })),
  };
}

/** Retire fulfilled rows without letting a DB blip break the read that found them. */
async function retire(requests: AccessRequestsService, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  try {
    await requests.markFulfilled(ids);
  } catch (err) {
    console.warn(
      `[groups] could not retire fulfilled requests: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
