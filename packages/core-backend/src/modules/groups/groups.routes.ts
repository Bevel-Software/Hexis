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
import { groupsWorkspaceId } from './groups.service.js';
import type {
  GroupCatalogEntry,
  GroupSummary,
  IGroupIndexService,
} from './groups.contract.js';

/**
 * Browser-facing (JWT) group routes, mounted behind `authMiddleware`:
 *
 *   GET  /api/groups                    → { groups: GroupSummary[] }
 *   POST /api/groups/:name/join-request → { ok, number }   (opens a CR)
 *
 * Enumeration is three verdicts per (caller, group), all of them ordinary
 * access resolution — no special cases, no side tables:
 *
 *   member       canRead on the group FOLDER
 *   manager      canWrite on the folder's access.md (admin-rescued)
 *   discoverable canRead on the access.md FILE — in the body-governed format
 *                its own `read: everyone` frontmatter grants this
 *
 * All three false ⇒ the group is absent from the response entirely.
 *
 * The join request is a plain change request: one commit on the caller's
 * deterministic join branch adding them to the body `read:` list, opened
 * against the default branch. The folder's writers approve by merging.
 * `hasRequested` is derived from the caller's own open CRs — nothing is
 * stored anywhere else.
 *
 * Auth gating is explicit and uniform: `authMiddleware` at the mount, PLUS a
 * `req.userEmail` check in every handler (the skills-routes pattern) so a
 * middleware change can never silently un-gate one. Nothing here is reachable
 * with an agent connection key or a manual-auth bearer.
 */
export function createGroupsRoutes(
  groupIndex: IGroupIndexService,
  accessControl: IAccessControl,
  workflow: IWorkflowService,
  workspaceService: WorkspaceService,
  kbDirName: string,
  resolveUser: (req: express.Request) => Promise<AuthUser | null>,
): express.Router {
  const router = express.Router();

  /** The folder-chain probe for MEMBERSHIP — the folder itself. */
  const memberProbe = (folder: string) => folder;
  /** The FILE probe for discovery/management — the folder's access.md. */
  const accessMdOf = (folder: string) => `${folder}/access.md`;

  const probesFor = (groups: GroupCatalogEntry[]): string[] => [
    ...new Set(groups.flatMap((g) => g.folders.flatMap((f) => [memberProbe(f), accessMdOf(f)]))),
  ];

  /** The caller's open join CR for `group`, or null. */
  const openJoinCr = (mine: ChangeRequest[], email: string, group: string): ChangeRequest | null =>
    mine.find((cr) => cr.state === 'open' && cr.branch === joinBranchFor(email, group)) ?? null;

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
      // Fail closed on every verdict: a path missing from the map is denied.
      const any = (map: Map<string, boolean>, g: GroupCatalogEntry, probe: (f: string) => string) =>
        g.folders.some((f) => map.get(probe(f)) === true);

      // The caller's own open join CRs — drives `hasRequested`. A CR-listing
      // hiccup must not take group enumeration down: degrade to "nothing
      // requested" and let the next load repair it.
      let mine: ChangeRequest[] = [];
      try {
        mine = await workflow.listChangeRequestsAuthoredBy(email);
      } catch (err) {
        console.warn(
          `[groups] join-request lookup failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const groups: GroupSummary[] = [];
      for (const g of catalog) {
        const member = any(readable, g, memberProbe);
        const manager = any(writable, g, accessMdOf);
        const discoverable = member || any(readable, g, accessMdOf);
        if (!member && !manager && !discoverable) continue; // absent — fail closed
        const joinCr = member ? null : openJoinCr(mine, email, g.name);
        groups.push({
          name: g.name,
          folders: g.folders,
          canRead: member,
          canWrite: manager,
          skillCount: g.skillCount,
          toolCount: g.toolCount,
          owners: g.owners,
          writers: g.writers,
          readers: g.readers,
          hasRequested: joinCr !== null,
          requestNumber: joinCr?.number ?? null,
        });
      }
      res.json({ groups });
    } catch (err) {
      console.error('[groups] failed to list groups:', err);
      res.status(500).json({ error: 'Failed to list groups' });
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
  router.post('/groups/:name/join-request', async (req, res) => {
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
      const catalog = await groupIndex.catalog();
      // Case-sensitive, like `groupOfPath` — the group name IS the folder name.
      const group = catalog.find((g) => g.name === req.params.name);
      const wsId = groupsWorkspaceId();
      // Same ANY-folder shape `GET /groups` resolves with, so a group can
      // never be listed as discoverable there and rejected as unknown here.
      const verdicts = group
        ? await accessControl.canReadBatch(
            wsId,
            email,
            group.folders.flatMap((f) => [memberProbe(f), accessMdOf(f)]),
          )
        : new Map<string, boolean>();
      const any = (probe: (f: string) => string) =>
        group?.folders.some((f) => verdicts.get(probe(f)) === true) ?? false;
      // Discovery gate, fail-closed: an unknown group and a group the caller
      // cannot discover answer IDENTICALLY, so probing can't confirm existence.
      if (!group || !any(accessMdOf)) {
        res.status(404).json({ error: 'Unknown group', kind: 'unknown-group' });
        return;
      }
      if (any(memberProbe)) {
        // Access landed between page load and click — reload, don't ask.
        res.status(409).json({ error: 'You can already read this group', kind: 'already-readable' });
        return;
      }
      // The grant is written to the group's primary folder — the one the
      // summary's `folders[0]` names and the banner's touched-path check
      // expects.
      const folder = group.folders[0];

      const branch = joinBranchFor(email, group.name);
      const existing = openJoinCr(await workflow.listChangeRequestsAuthoredBy(email), email, group.name);
      if (existing) {
        res.json({ ok: true, number: existing.number });
        return;
      }

      // A leftover branch from a rejected/withdrawn request is reused — the
      // grant commit is already on it and the splice below no-ops.
      try {
        await workflow.createBranch(groupsWorkspaceId(), branch, DEFAULT_BRANCH);
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
        await workflow.commitChanges(ws.id, user, `Request access to ${group.name}`);
      }
      const detail = await workflow.openChangeRequest(ws.id, user, {
        sourceBranch: branch,
        targetBranch: DEFAULT_BRANCH,
        title: `Join request: ${group.name}`,
        description:
          `${user.name} asked to join ${group.name}. Merging adds them to the group's ` +
          `read access; rejecting declines the request.`,
      });
      res.json({ ok: true, number: detail.number });
    } catch (err) {
      if (err instanceof WorkflowDomainError) {
        res.status(err.status).json({ error: err.message, ...(err.payload ?? {}) });
        return;
      }
      console.error('[groups] failed to open a join request:', err);
      res.status(500).json({ error: 'Failed to request access' });
    }
  });

  return router;
}
