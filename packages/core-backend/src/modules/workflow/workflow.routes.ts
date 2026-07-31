/**
 * `/workflow/*` HTTP surface — the route family the frontend and agent
 * should reach for instead of `/git/*` and `/pr/*`. Today these are additive
 * (the old families keep working); migration plan in `bevel-platform/PLAN.md`.
 *
 * URL layout:
 *   /workspace/:id/workflow/...     — workspace-scoped ops (branches, changes, locks, compare)
 *   /workflow/change-requests/...   — change-request ops (list/detail/comments/approvals/merge/reject)
 *
 * Workspace ids are `encodeURIComponent(branch)` (PLAN §3) — branches are
 * shared by every user editing them, so route handlers gate on
 * authentication only. Coordination of concurrent edits happens via the
 * file-lock service, not via per-user clones.
 *
 * Error mapping: every workflow error class extends `WorkflowDomainError`
 * which exposes `.status` + optional `.payload`, so a single `toHttpError`
 * covers all branches/changes/CR errors uniformly.
 */

import express from 'express';
import type {
  AuthUser,
  ChangeInput,
  IWorkflowService,
  OpenChangeRequestInput,
  PostChangeRequestCommentInput,
} from '@bevel-software/shared';
import type { AuthService } from '../auth/auth.service.js';
import type { WorkspaceService } from '../workspace/workspace.service.js';
import { branchForWorkspaceId } from '../workspace/workspace.service.js';
import type { WorkflowEventBus } from './event-bus.js';
import { WorkflowDomainError } from './workflow.errors.js';
import '../auth/auth.middleware.js'; // Express Request augmentation

function toHttpError(
  err: unknown,
): { status: number; body: Record<string, unknown> } {
  if (err instanceof WorkflowDomainError) {
    return {
      status: err.status,
      body: { error: err.message, ...(err.payload ?? {}) },
    };
  }
  console.error('[workflow.routes] unhandled error:', err);
  return { status: 500, body: { error: 'Internal server error' } };
}

function parsePrNumber(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n > 0 && Number.isSafeInteger(n) ? n : null;
}

function isTruthyQuery(v: unknown): boolean {
  return v === '1' || v === 'true';
}

export function createWorkflowRoutes(
  workflow: IWorkflowService,
  workspaceService: WorkspaceService,
  authService: AuthService,
  events: WorkflowEventBus,
): express.Router {
  const router = express.Router({ mergeParams: true });

  /**
   * Authentication gate. Per PLAN §3, branches are shared workspaces —
   * any authenticated user can access any branch. Authorization for
   * mutations happens at the workflow / git layer (access tree, file
   * locks, change-request approval gate). This helper just resolves the
   * caller's `AuthUser` record; route bodies pass it to workflow methods
   * for per-operation auth.
   */
  async function requireUser(
    req: express.Request,
    res: express.Response,
  ): Promise<AuthUser | null> {
    if (!req.userId) {
      res.status(401).json({ error: 'Unauthenticated' });
      return null;
    }
    try {
      const user = await authService.getUserById(req.userId);
      if (!user) {
        res.status(401).json({ error: 'User not found' });
        return null;
      }
      return user;
    } catch (err) {
      console.error('[workflow.routes] requireUser failed:', err);
      res.status(500).json({ error: 'Internal server error' });
      return null;
    }
  }

  // ── Branches ──────────────────────────────────────────────────────────────

  router.get('/workspace/:id/workflow/branches', async (req, res) => {
    if (!(await requireUser(req, res))) return;
    try {
      // `?fresh=1` forces a `git fetch --prune` (bypasses the implicit-fetch
      // TTL) so a user-initiated refresh — e.g. opening the branch selector —
      // immediately reflects branches another workspace just created/deleted.
      const freshFetch = isTruthyQuery(req.query.fresh);
      res.json(await workflow.listBranches(req.params.id, { freshFetch }));
    } catch (err) {
      const { status, body } = toHttpError(err);
      res.status(status).json(body);
    }
  });

  router.post('/workspace/:id/workflow/branches', async (req, res) => {
    if (!(await requireUser(req, res))) return;
    const { name, fromBase } = req.body as { name?: string; fromBase?: string };
    if (!name) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    try {
      res.json(await workflow.createBranch(req.params.id, name, fromBase));
    } catch (err) {
      const { status, body } = toHttpError(err);
      res.status(status).json(body);
    }
  });

  router.delete('/workspace/:id/workflow/branches/:name', async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    const onlyIfNoRemote = isTruthyQuery(req.query.onlyIfNoRemote);
    try {
      await workflow.deleteBranch(req.params.id, req.params.name, user, { onlyIfNoRemote });
      res.json({ status: 'deleted' });
    } catch (err) {
      const { status, body } = toHttpError(err);
      res.status(status).json(body);
    }
  });

  // The legacy `POST /workspace/:id/workflow/switch` route is gone. Under
  // the per-branch workspace model the UI switches branches by navigating
  // the URL — the frontend's workspace bootstrap clones (or selects) the
  // destination branch's per-branch workspace dir. There is no separate
  // server-side "switch" step on the source workspace's clone, which was
  // the only place a dirty working tree could leak as a user-facing 409.

  // `POST /workspace/:id/workflow/fork-draft` removed: the dirty-tree
  // carry-along escape hatch has no callers under save=share + per-branch
  // workspaces. Use `POST /workflow/branches` (createBranch) instead.

  router.get('/workspace/:id/workflow/branch-status', async (req, res) => {
    if (!(await requireUser(req, res))) return;
    try {
      // Make sure the per-branch workspace is fully cloned before we run any
      // git command against it. Without this, a frontend hitting branch-status
      // on first load can race the cold clone and `git rev-parse HEAD` returns
      // "ambiguous argument 'HEAD'" against a half-initialised .git directory.
      // The call is idempotent and ~free in the warm case (Map lookup), so it
      // costs nothing once the workspace is already on disk.
      await workspaceService.getOrCreateForBranch(branchForWorkspaceId(req.params.id));
      res.json(await workflow.branchStatus(req.params.id));
    } catch (err) {
      const { status, body } = toHttpError(err);
      res.status(status).json(body);
    }
  });

  // `POST /workspace/:id/workflow/discard` removed: under save=share the
  // working tree is never dirty, so there's nothing to discard.

  router.post('/workspace/:id/workflow/share', async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    try {
      await workflow.shareCurrentBranch(req.params.id, user);
      res.json({ status: 'shared' });
    } catch (err) {
      const { status, body } = toHttpError(err);
      res.status(status).json(body);
    }
  });

  router.post('/workspace/:id/workflow/refresh-remotes', async (req, res) => {
    if (!(await requireUser(req, res))) return;
    try {
      await workflow.refreshRemotes(req.params.id);
      res.json({ status: 'refreshed' });
    } catch (err) {
      const { status, body } = toHttpError(err);
      res.status(status).json(body);
    }
  });

  router.post('/workspace/:id/workflow/update-from-remote', async (req, res) => {
    if (!(await requireUser(req, res))) return;
    try {
      await workflow.updateFromRemote(req.params.id);
      res.json({ status: 'updated' });
    } catch (err) {
      const { status, body } = toHttpError(err);
      res.status(status).json(body);
    }
  });

  router.get('/workspace/:id/workflow/fork-base', async (req, res) => {
    if (!(await requireUser(req, res))) return;
    const branch = typeof req.query.branch === 'string' ? req.query.branch : '';
    if (!branch) {
      res.status(400).json({ error: 'branch is required' });
      return;
    }
    try {
      const base = await workflow.resolveForkBase(req.params.id, branch);
      res.json({ base });
    } catch (err) {
      const { status, body } = toHttpError(err);
      res.status(status).json(body);
    }
  });

  router.get('/workspace/:id/workflow/pending-changes', async (req, res) => {
    if (!(await requireUser(req, res))) return;
    try {
      const paths = await workflow.listPendingChangePaths(req.params.id);
      res.json({ paths });
    } catch (err) {
      const { status, body } = toHttpError(err);
      res.status(status).json(body);
    }
  });

  // `GET /workspace/:id/workflow/working-changes` + `working-diff` removed:
  // working-tree dirty state is always empty under save=share.

  // ── Changes ───────────────────────────────────────────────────────────────

  router.post('/workspace/:id/workflow/changes', async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    const input = req.body as ChangeInput;
    try {
      res.json(await workflow.commitChange(req.params.id, user, input));
    } catch (err) {
      const { status, body } = toHttpError(err);
      res.status(status).json(body);
    }
  });

  router.get('/workspace/:id/workflow/changes', async (req, res) => {
    if (!(await requireUser(req, res))) return;
    const pathParam = typeof req.query.path === 'string' ? req.query.path : '';
    if (!pathParam) {
      res.status(400).json({ error: 'path is required' });
      return;
    }
    const rawLimit = Number.parseInt(String(req.query.limit ?? '20'), 10);
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(rawLimit, 100)) : 20;
    try {
      res.json({ changes: await workflow.listChangesForFile(req.params.id, pathParam, limit) });
    } catch (err) {
      const { status, body } = toHttpError(err);
      res.status(status).json(body);
    }
  });

  router.post('/workspace/:id/workflow/changes/:sha/revert', async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    try {
      res.json(await workflow.revertChange(req.params.id, user, req.params.sha));
    } catch (err) {
      const { status, body } = toHttpError(err);
      res.status(status).json(body);
    }
  });

  router.get('/workspace/:id/workflow/compare-file', async (req, res) => {
    if (!(await requireUser(req, res))) return;
    const pathParam = typeof req.query.path === 'string' ? req.query.path : '';
    const fromBranch = typeof req.query.from === 'string' ? req.query.from : '';
    const toBranch = typeof req.query.to === 'string' ? req.query.to : '';
    if (!pathParam || !fromBranch || !toBranch) {
      res.status(400).json({ error: 'path, from, and to are required' });
      return;
    }
    try {
      const diff = await workflow.compareFile(req.params.id, pathParam, fromBranch, toBranch);
      res.json({ diff });
    } catch (err) {
      const { status, body } = toHttpError(err);
      res.status(status).json(body);
    }
  });

  router.get('/workspace/:id/workflow/show-file', async (req, res) => {
    if (!(await requireUser(req, res))) return;
    const pathParam = typeof req.query.path === 'string' ? req.query.path : '';
    const sha = typeof req.query.sha === 'string' ? req.query.sha : '';
    if (!pathParam || !sha) {
      res.status(400).json({ error: 'path and sha are required' });
      return;
    }
    try {
      const diff = await workflow.showFileAtChange(req.params.id, pathParam, sha);
      res.json({ diff });
    } catch (err) {
      const { status, body } = toHttpError(err);
      res.status(status).json(body);
    }
  });

  // ── File locks ────────────────────────────────────────────────────────────

  router.post('/workspace/:id/workflow/locks', async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    const { branch, path: targetPath } = req.body as { branch?: string; path?: string };
    if (!branch || !targetPath) {
      res.status(400).json({ error: 'branch and path are required' });
      return;
    }
    try {
      res.json(await workflow.acquireLock(req.params.id, branch, targetPath, user));
    } catch (err) {
      const { status, body } = toHttpError(err);
      res.status(status).json(body);
    }
  });

  // Release: branch + path travel via the body, not the query string,
  // because DELETE bodies are reliable for our own clients. Under the
  // pending-commits queue the release no longer returns a `Change` — the
  // commit hasn't happened yet (the background worker drains the queue
  // out of band). The route's `{ queued: true }` reply just signals
  // "lock released, commit scheduled."
  router.delete('/workspace/:id/workflow/locks', async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    const body = (req.body ?? {}) as { branch?: string; path?: string };
    const branch = body.branch ?? (typeof req.query.branch === 'string' ? req.query.branch : '');
    const targetPath = body.path ?? (typeof req.query.path === 'string' ? req.query.path : '');
    if (!branch || !targetPath) {
      res.status(400).json({ error: 'branch and path are required' });
      return;
    }
    try {
      await workflow.releaseLock(req.params.id, branch, targetPath, user);
      res.json({ queued: true });
    } catch (err) {
      const { status, body } = toHttpError(err);
      res.status(status).json(body);
    }
  });

  // Commit-while-locked — autosave checkpoint. Lock stays held; the
  // file's accumulated edits land as a one-file change.
  router.post('/workspace/:id/workflow/locks/checkpoint', async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    const { branch, path: targetPath, summary } = req.body as {
      branch?: string;
      path?: string;
      summary?: string;
    };
    if (!branch || !targetPath) {
      res.status(400).json({ error: 'branch and path are required' });
      return;
    }
    try {
      const change = await workflow.commitFileWhileLocked(
        req.params.id,
        branch,
        targetPath,
        user,
        summary,
      );
      res.json({ change });
    } catch (err) {
      const { status, body } = toHttpError(err);
      res.status(status).json(body);
    }
  });

  router.post('/workspace/:id/workflow/locks/heartbeat', async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    const { branch, path: targetPath } = req.body as { branch?: string; path?: string };
    if (!branch || !targetPath) {
      res.status(400).json({ error: 'branch and path are required' });
      return;
    }
    try {
      res.json(await workflow.heartbeatLock(req.params.id, branch, targetPath, user));
    } catch (err) {
      const { status, body } = toHttpError(err);
      res.status(status).json(body);
    }
  });

  router.get('/workspace/:id/workflow/locks', async (req, res) => {
    if (!(await requireUser(req, res))) return;
    const branch = typeof req.query.branch === 'string' ? req.query.branch : '';
    const targetPath = typeof req.query.path === 'string' ? req.query.path : '';
    if (!branch || !targetPath) {
      res.status(400).json({ error: 'branch and path are required' });
      return;
    }
    try {
      res.json({ lock: await workflow.getLock(req.params.id, branch, targetPath) });
    } catch (err) {
      const { status, body } = toHttpError(err);
      res.status(status).json(body);
    }
  });

  // ── Change Requests ───────────────────────────────────────────────────────

  router.get('/workflow/change-requests', async (req, res) => {
    const fresh = isTruthyQuery(req.query.fresh);
    try {
      res.json(await workflow.listChangeRequests({ fresh }));
    } catch (err) {
      const { status, body } = toHttpError(err);
      res.status(status).json(body);
    }
  });

  router.get('/workflow/change-requests/mine', async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    try {
      res.json(await workflow.listChangeRequestsAuthoredBy(user.email));
    } catch (err) {
      const { status, body } = toHttpError(err);
      res.status(status).json(body);
    }
  });

  router.get('/workflow/change-requests/for-me', async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    const fresh = isTruthyQuery(req.query.fresh);
    try {
      const workspace = await workspaceService.getOrCreateForUser(user);
      res.json(await workflow.listChangeRequestsForUser(workspace.id, user.email, { fresh }));
    } catch (err) {
      const { status, body } = toHttpError(err);
      res.status(status).json(body);
    }
  });

  router.get('/workflow/change-requests/:number', async (req, res) => {
    const num = parsePrNumber(req.params.number);
    if (num === null) {
      res.status(400).json({ error: 'invalid change request number' });
      return;
    }
    try {
      const cr = await workflow.getChangeRequest(num);
      if (!cr) {
        res.status(404).json({ error: 'change request not found' });
        return;
      }
      res.json(cr);
    } catch (err) {
      const { status, body } = toHttpError(err);
      res.status(status).json(body);
    }
  });

  router.get('/workflow/change-requests/:number/detail', async (req, res) => {
    const num = parsePrNumber(req.params.number);
    if (num === null) {
      res.status(400).json({ error: 'invalid change request number' });
      return;
    }
    try {
      const fresh = isTruthyQuery(req.query.fresh);
      let workspaceId: string | undefined;
      let viewerEmail: string | undefined;
      // Best-effort caller resolution — anonymous detail fetches still work
      // (mirroring the legacy /pr/:n/detail behaviour), they just don't get
      // `viewerCanApprove` populated.
      if (req.userId) {
        try {
          const user = await authService.getUserById(req.userId);
          if (user) {
            const ws = await workspaceService.getOrCreateForUser(user);
            workspaceId = ws.id;
            viewerEmail = user.email;
          }
        } catch {
          // Swallow — keeps the detail fetch resilient to a transient auth
          // blip when the caller's workspace isn't yet provisioned.
        }
      }
      const detail = await workflow.getChangeRequestDetail(num, {
        fresh,
        workspaceId,
        viewerEmail,
      });
      if (!detail) {
        res.status(404).json({ error: 'change request not found' });
        return;
      }
      res.json(detail);
    } catch (err) {
      const { status, body } = toHttpError(err);
      res.status(status).json(body);
    }
  });

  router.post('/workflow/change-requests', async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    const body = req.body as Partial<OpenChangeRequestInput>;
    if (!body.sourceBranch || !body.targetBranch || !body.title) {
      res.status(400).json({ error: 'sourceBranch, targetBranch and title are required' });
      return;
    }
    try {
      // Resolve the source-branch workspace — `git.mergeFromOrigin`
      // requires the clone to be checked out to `sourceBranch`, and with
      // workspace-per-branch the right clone is `workspaces/<encoded
      // sourceBranch>/...`. Falling back to `getOrCreateForUser` returned
      // the default workspace (target-company-state), which broke CRs
      // whose source wasn't the default. `getOrCreateForBranch` lazily
      // bootstraps the clone if this is the first request for it.
      const workspace = await workspaceService.getOrCreateForBranch(body.sourceBranch);
      res.json(
        await workflow.openChangeRequest(workspace.id, user, {
          sourceBranch: body.sourceBranch,
          targetBranch: body.targetBranch,
          title: body.title,
          description: body.description,
        }),
      );
    } catch (err) {
      const { status, body } = toHttpError(err);
      res.status(status).json(body);
    }
  });

  router.post('/workflow/change-requests/:number/update-from-target', async (req, res) => {
    const num = parsePrNumber(req.params.number);
    if (num === null) {
      res.status(400).json({ error: 'invalid change request number' });
      return;
    }
    const user = await requireUser(req, res);
    if (!user) return;
    try {
      // `updateFromTarget` re-runs the `target → source` merge, which
      // needs the source branch's workspace (the on-disk clone checked
      // out to that branch). Discover the source branch from the CR
      // first, then resolve the matching workspace — same reasoning as
      // `openChangeRequest` above. `getOrCreateForBranch` lazily clones
      // if the source branch hasn't been touched on this replica yet.
      const cr = await workflow.getChangeRequest(num);
      if (!cr) {
        res.status(404).json({ error: 'change request not found' });
        return;
      }
      const workspace = await workspaceService.getOrCreateForBranch(cr.branch);
      res.json(await workflow.updateFromTarget(workspace.id, user, num));
    } catch (err) {
      const { status, body } = toHttpError(err);
      res.status(status).json(body);
    }
  });

  router.get('/workflow/change-requests/:number/comments', async (req, res) => {
    const num = parsePrNumber(req.params.number);
    if (num === null) {
      res.status(400).json({ error: 'invalid change request number' });
      return;
    }
    try {
      res.json(await workflow.listComments(num));
    } catch (err) {
      const { status, body } = toHttpError(err);
      res.status(status).json(body);
    }
  });

  router.post('/workflow/change-requests/:number/comments', async (req, res) => {
    const num = parsePrNumber(req.params.number);
    if (num === null) {
      res.status(400).json({ error: 'invalid change request number' });
      return;
    }
    const user = await requireUser(req, res);
    if (!user) return;
    const body = (req.body ?? {}) as Partial<PostChangeRequestCommentInput>;
    if (typeof body.body !== 'string') {
      res.status(400).json({ error: 'body is required' });
      return;
    }
    try {
      // Resolve the current head from the detail endpoint so the comment
      // anchors against what the user is actually viewing. Mirrors the
      // legacy /pr/:n/comments handler.
      const detail = await workflow.getChangeRequestDetail(num, { fresh: true });
      if (!detail) {
        res.status(404).json({ error: 'change request not found' });
        return;
      }
      const comment = await workflow.postComment(
        num,
        user,
        {
          body: body.body,
          path: body.path,
          line: body.line,
          parentId: body.parentId,
        },
        detail.headSha,
      );
      res.json(comment);
    } catch (err) {
      const { status, body } = toHttpError(err);
      res.status(status).json(body);
    }
  });

  router.patch('/workflow/change-requests/:number/comments/:id', async (req, res) => {
    const num = parsePrNumber(req.params.number);
    if (num === null) {
      res.status(400).json({ error: 'invalid change request number' });
      return;
    }
    const user = await requireUser(req, res);
    if (!user) return;
    const body = (req.body ?? {}) as { body?: unknown };
    if (typeof body.body !== 'string') {
      res.status(400).json({ error: 'body is required' });
      return;
    }
    try {
      res.json(await workflow.editComment(req.params.id, num, user, body.body));
    } catch (err) {
      const { status, body } = toHttpError(err);
      res.status(status).json(body);
    }
  });

  router.delete('/workflow/change-requests/:number/comments/:id', async (req, res) => {
    const num = parsePrNumber(req.params.number);
    if (num === null) {
      res.status(400).json({ error: 'invalid change request number' });
      return;
    }
    const user = await requireUser(req, res);
    if (!user) return;
    try {
      await workflow.deleteComment(req.params.id, num, user);
      res.json({ status: 'deleted' });
    } catch (err) {
      const { status, body } = toHttpError(err);
      res.status(status).json(body);
    }
  });

  // Approve / unapprove. Both fetch fresh detail so the approval pins to the
  // current head — a stale cached head could let the gate accept an approval
  // the user never actually saw.
  router.post('/workflow/change-requests/:number/files/approve', async (req, res) => {
    const num = parsePrNumber(req.params.number);
    if (num === null) {
      res.status(400).json({ error: 'invalid change request number' });
      return;
    }
    const user = await requireUser(req, res);
    if (!user) return;
    const body = (req.body ?? {}) as { path?: string };
    if (typeof body.path !== 'string' || !body.path) {
      res.status(400).json({ error: 'path is required' });
      return;
    }
    try {
      const workspace = await workspaceService.getOrCreateForUser(user);
      const detail = await workflow.getChangeRequestDetail(num, {
        fresh: true,
        workspaceId: workspace.id,
        viewerEmail: user.email,
      });
      if (!detail) {
        res.status(404).json({ error: 'change request not found' });
        return;
      }
      const approvals = await workflow.approveFile(
        num,
        body.path,
        user,
        detail.files,
        detail.headSha,
        detail.base,
        detail.authorId ?? null,
        workspace.id,
      );
      res.json({ approvals });
    } catch (err) {
      const { status, body } = toHttpError(err);
      res.status(status).json(body);
    }
  });

  router.delete('/workflow/change-requests/:number/files/approve', async (req, res) => {
    const num = parsePrNumber(req.params.number);
    if (num === null) {
      res.status(400).json({ error: 'invalid change request number' });
      return;
    }
    const user = await requireUser(req, res);
    if (!user) return;
    const targetPath = typeof req.query.path === 'string' ? req.query.path : '';
    if (!targetPath) {
      res.status(400).json({ error: 'path is required' });
      return;
    }
    try {
      const workspace = await workspaceService.getOrCreateForUser(user);
      const detail = await workflow.getChangeRequestDetail(num, {
        fresh: true,
        workspaceId: workspace.id,
        viewerEmail: user.email,
      });
      if (!detail) {
        res.status(404).json({ error: 'change request not found' });
        return;
      }
      const approvals = await workflow.unapproveFile(
        num,
        targetPath,
        user,
        detail.files,
        detail.headSha,
        detail.base,
        detail.authorId ?? null,
        workspace.id,
      );
      res.json({ approvals });
    } catch (err) {
      const { status, body } = toHttpError(err);
      res.status(status).json(body);
    }
  });

  router.post('/workflow/change-requests/:number/reject', async (req, res) => {
    const num = parsePrNumber(req.params.number);
    if (num === null) {
      res.status(400).json({ error: 'invalid change request number' });
      return;
    }
    const user = await requireUser(req, res);
    if (!user) return;
    try {
      const workspace = await workspaceService.getOrCreateForUser(user);
      const detail = await workflow.getChangeRequestDetail(num, {
        fresh: true,
        workspaceId: workspace.id,
        viewerEmail: user.email,
      });
      if (!detail) {
        res.status(404).json({ error: 'change request not found' });
        return;
      }
      const result = await workflow.rejectChangeRequest(
        num,
        user,
        detail.state,
        detail.authorId ?? null,
        detail.base,
        workspace.id,
      );
      res.json(result);
    } catch (err) {
      const { status, body } = toHttpError(err);
      res.status(status).json(body);
    }
  });

  router.post('/workflow/change-requests/:number/merge', async (req, res) => {
    const num = parsePrNumber(req.params.number);
    if (num === null) {
      res.status(400).json({ error: 'invalid change request number' });
      return;
    }
    const user = await requireUser(req, res);
    if (!user) return;
    const body = (req.body ?? {}) as { bypass?: unknown };
    const bypass = body.bypass === true;

    // Async merge. The gate re-validation fetches the PR's full file list from
    // GitHub (paginated — slow on a large change request) and `gh pr merge` can
    // itself take tens of seconds, long enough to outlive the gateway's idle
    // timeout — surfacing to the user as a 502 even while the merge is still
    // running. So we ack with 202 and run the merge in the background, reporting
    // the result over the event bus: `change-request-merged` on success (emitted
    // by the workflow service; the PR viewer refreshes off it), and a
    // user-scoped `change-request-merge-failed` on a gate block / conflict /
    // merge error so the UI that kicked it off can react.
    res.status(202).json({ status: 'merging', number: num });
    void (async () => {
      try {
        const workspace = await workspaceService.getOrCreateForUser(user);
        const detail = await workflow.getChangeRequestDetail(num, {
          fresh: true,
          workspaceId: workspace.id,
          viewerEmail: user.email,
        });
        if (!detail) {
          events.emit({
            kind: 'change-request-merge-failed',
            forUserId: user.id,
            number: num,
            reason: 'change request not found',
            conflicts: false,
          });
          return;
        }
        const outcome = await workflow.mergeChangeRequest(
          num,
          user,
          detail.headSha,
          detail.approvals,
          detail.state,
          detail.title,
          detail.base,
          workspace.id,
          { bypass },
        );
        if (outcome.kind === 'conflicts-need-resolution') {
          events.emit({
            kind: 'change-request-merge-failed',
            forUserId: user.id,
            number: num,
            reason: 'This draft conflicts with the target and needs resolving first.',
            conflicts: true,
          });
        }
        // Success path: `workflow.mergeChangeRequest` emits `change-request-merged`.
      } catch (err) {
        const { body: errBody } = toHttpError(err);
        console.error(`[workflow.routes] async merge of change request #${num} failed:`, err);
        events.emit({
          kind: 'change-request-merge-failed',
          forUserId: user.id,
          number: num,
          reason: typeof errBody.error === 'string' ? errBody.error : 'Merge failed',
          conflicts: false,
        });
      }
    })();
  });

  return router;
}
