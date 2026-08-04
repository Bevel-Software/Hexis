import express from 'express';
import '../auth/auth.middleware.js'; // Express Request.userId / userEmail augmentation
import type { IAccessControl } from '../access/access-control.interface.js';
import { groupsWorkspaceId } from './groups.service.js';
import type {
  GroupCatalogEntry,
  GroupSummary,
  IGroupIndexService,
} from './groups.contract.js';

/**
 * Browser-facing (JWT) group routes, mounted behind `authMiddleware`. ONE
 * endpoint — enumeration only, nothing here touches the knowledge base:
 *
 *   GET /api/groups → { groups: GroupSummary[] }
 *
 * Fail-closed like every other read surface: a group the caller can neither
 * read nor write is ABSENT from the response — its name, its counts and its
 * principals never leave the backend. `canWrite` keeps a group visible to a
 * platform Admin whom admin-rescue lets manage an `access.md` they cannot
 * read, so the self-service way back in survives.
 *
 * Auth gating is explicit and uniform: `authMiddleware` at the mount, PLUS a
 * `req.userEmail` check in the handler (the skills-routes pattern) so a
 * middleware change can never silently un-gate it. Nothing here is reachable
 * with an agent connection key or a manual-auth bearer.
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
  accessControl: IAccessControl,
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

      const groups: GroupSummary[] = catalog
        .map((g) => ({
          name: g.name,
          folders: g.folders,
          canRead: verdict(readable, g),
          canWrite: verdict(writable, g),
          skillCount: g.skillCount,
          toolCount: g.toolCount,
          owners: g.owners,
          writers: g.writers,
          readers: g.readers,
        }))
        .filter((g) => g.canRead || g.canWrite);
      res.json({ groups });
    } catch (err) {
      console.error('[groups] failed to list groups:', err);
      res.status(500).json({ error: 'Failed to list groups' });
    }
  });

  return router;
}

/** The folder-chain readability probe for a group folder. */
function accessProbe(folder: string): string {
  return `${folder}/access.md`;
}
