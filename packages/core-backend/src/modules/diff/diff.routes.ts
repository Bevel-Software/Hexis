import express from 'express';
import type { AuthUser, IWorkflowService } from '@bevel-software/platform-shared';
import type { IDiffService } from './diff.interface.js';
import type { AuthService } from '../auth/auth.service.js';
import type { IAccessControl } from '../access/access-control.interface.js';
import { canReadWorkspacePath, toKbRelative, resolveReadableMap } from '../access-model/kb-read-filter.js';
import { WorkflowDomainError, WorkflowValidationError } from '../../shared/domain-errors.js';
import { LockingFilesystem } from '../kb-fs/locking-filesystem.js';
import { branchForWorkspaceId } from '../../shared/workspace-id.js';
import '../auth/auth.middleware.js';

function toHttpError(
  err: unknown,
): { status: number; body: Record<string, unknown> } {
  if (err instanceof WorkflowDomainError) {
    return {
      status: err.status,
      body: { error: err.message, ...(err.payload ?? {}) },
    };
  }
  const message = err instanceof Error ? err.message : 'Unknown error';
  return { status: 500, body: { error: message } };
}

/**
 * Reject the given paths as ONE atomic batch via `LockingFilesystem.writeFiles`:
 * acquire every path's lock up front, restore each pre-agent baseline on disk
 * (or delete an agent-added file), then commit + push the whole set as a single
 * change and release. Fail-closed: a contended lock or a failed write/commit
 * aborts the batch with nothing committed (`writeFiles` discards the
 * uncommitted bytes via `releaseLockNoCommit`).
 *
 * This replaced a per-path acquire → `DiffService.rejectOne` → `releaseLock`
 * loop, which was O(changes × workspace-size) — every `rejectOne` re-walked and
 * re-diffed the whole workspace to recompute the session — and queued one
 * background commit + push PER FILE. On a large agent change-set that pinned
 * the reject for many minutes; the batch is one walk (`revertPlan`), one lock
 * sweep, one commit.
 *
 * The lock-first property is preserved: `writeFiles` holds every lock before
 * the first disk mutation, so a restore can never race a concurrent editor.
 */
export async function rejectPathsLocked(
  workflowService: IWorkflowService,
  diffService: IDiffService,
  workspaceId: string,
  user: AuthUser,
  kbDirName: string,
  paths: string[],
): Promise<void> {
  if (paths.length === 0) return;
  const branch = branchForWorkspaceId(workspaceId);
  const plan = await diffService.revertPlan(workspaceId, paths);
  const total = plan.writes.length + plan.deletes.length;
  if (total === 0) return;
  const lockingFs = new LockingFilesystem(
    { basePath: plan.workspaceDir, contained: true },
    { workflow: workflowService, workspaceId, branch, user, kbDirName },
  );
  try {
    await lockingFs.writeFiles(
      plan.writes,
      `Revert agent changes (${total} file${total === 1 ? '' : 's'})`,
      plan.deletes,
    );
  } catch (err) {
    // Fail-closed: writeFiles committed nothing. Surface ONE clean 4xx
    // sentence (the raw error is status-less → would 500). The contention
    // case is rebuilt rather than nested: writeFiles' own text says
    // "Continuing with other edits", which is wrong here — the batch aborted.
    const raw = err instanceof Error ? err.message : 'unknown error';
    const contended = /Skipped editing "(.+?)" — locked by (.+?)\./.exec(raw);
    const reason = contended
      ? `"${contended[1]}" is being edited by ${contended[2]}`
      : raw.replace(/\.\s*$/, '');
    throw new WorkflowValidationError(
      `Couldn't revert: ${reason}. No changes were committed — try again when the files are free.`,
    );
  }
}

/**
 * Pending-changes API. URL paths are preserved from the previous review
 * service so the frontend wire contract is unchanged.
 *   GET  /workspace/:id/review                → { session: ReviewSession | null }
 *   GET  /workspace/:id/review/file?path=...  → FileDiffPayload
 *   POST /workspace/:id/review/accept         → { session }; body { path? }
 *   POST /workspace/:id/review/reject         → { session }; body { path? }
 */
export function createDiffRoutes(
  diffService: IDiffService,
  authService: AuthService,
  workflowService: IWorkflowService,
  accessControl: IAccessControl,
  kbDirName: string,
): express.Router {
  const router = express.Router({ mergeParams: true });

  // Authentication gate only. Per PLAN §3 the workspace `:id` is a branch
  // identifier — any authenticated user can access any branch.
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
      const { status, body } = toHttpError(err);
      res.status(status).json(body);
      return null;
    }
  }

  /** Filter change paths to those the caller may read (same gate as GET /review). */
  async function readablePaths(
    workspaceId: string,
    email: string,
    paths: string[],
  ): Promise<string[]> {
    if (paths.length === 0) return [];
    const verdict = await resolveReadableMap(
      (w, e, rels) => accessControl.canReadBatch(w, e, rels),
      workspaceId,
      email,
      kbDirName,
      paths,
    );
    return paths.filter((p) => verdict.get(p) === true);
  }

  /** Read gate for a single change path (mirrors GET /review/file). Returns true to proceed. */
  function canReadPath(workspaceId: string, email: string, pathParam: string): Promise<boolean> {
    return canReadWorkspacePath(
      (w, e, p) => accessControl.canRead(w, e, p),
      workspaceId,
      email,
      kbDirName,
      pathParam,
    );
  }

  router.get('/workspace/:id/review', async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    try {
      let session = await diffService.currentSession(req.params.id);
      // Drop changes to nodes the caller can't read — the review view must not
      // leak a restricted node's path or that it changed. Change paths are
      // workspace-relative (kbDir-prefixed); FULL read check (per-node
      // frontmatter), matching the content route. An emptied session → null,
      // matching the "nothing to review" contract.
      if (session) {
        const verdict = await resolveReadableMap(
          (w, e, rels) => accessControl.canReadBatch(w, e, rels),
          req.params.id,
          user.email,
          kbDirName,
          session.changes.map((c) => c.path),
        );
        const changes = session.changes.filter((c) => verdict.get(c.path) === true);
        session = changes.length > 0 ? { ...session, changes } : null;
      }
      res.json({ session });
    } catch (err) {
      const { status, body } = toHttpError(err);
      res.status(status).json(body);
    }
  });

  router.get('/workspace/:id/review/file', async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    const pathParam = typeof req.query.path === 'string' ? req.query.path : '';
    if (!pathParam) {
      res.status(400).json({ error: 'path query param is required' });
      return;
    }
    try {
      // Read gate (mirrors the content route's assertCanRead). Non-KB paths
      // (toKbRelative → null) carry no read rules and pass.
      const rel = toKbRelative(pathParam, kbDirName);
      if (rel !== null && !(await accessControl.canRead(req.params.id, user.email, rel))) {
        res.status(403).json({ error: `You don't have permission to read "${pathParam}".` });
        return;
      }
      const payload = await diffService.fileDiff(req.params.id, pathParam);
      res.json(payload);
    } catch (err) {
      const { status, body } = toHttpError(err);
      res.status(status).json(body);
    }
  });

  router.post('/workspace/:id/review/accept', async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    const pathParam = (req.body ?? {} as { path?: unknown }).path as unknown;
    if (pathParam !== undefined && typeof pathParam !== 'string') {
      res.status(400).json({ error: 'path must be a string when provided' });
      return;
    }
    try {
      if (pathParam) {
        // Gate the single path: never let a caller accept a change they can't read.
        if (!(await canReadPath(req.params.id, user.email, pathParam))) {
          res.status(403).json({ error: `You don't have permission to read "${pathParam}".` });
          return;
        }
        const session = await diffService.acceptOne(req.params.id, pathParam);
        res.json({ session });
      } else {
        // Accept-all only acts on changes the caller may read — restricted nodes
        // stay pending rather than being silently mutated. ONE batched service
        // call: looping `acceptOne` here re-walked + re-diffed the whole
        // workspace per accepted file (O(changes × files)), which pinned this
        // request for minutes on large agent change-sets.
        const current = await diffService.currentSession(req.params.id);
        const readable = await readablePaths(
          req.params.id,
          user.email,
          current?.changes.map((c) => c.path) ?? [],
        );
        await diffService.acceptAll(req.params.id, readable);
        // Recompute once: non-null when restricted nodes stayed pending.
        const session = await diffService.currentSession(req.params.id);
        res.json({ session });
      }
    } catch (err) {
      const { status, body } = toHttpError(err);
      res.status(status).json(body);
    }
  });

  router.post('/workspace/:id/review/reject', async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    const pathParam = (req.body ?? {} as { path?: unknown }).path as unknown;
    if (pathParam !== undefined && typeof pathParam !== 'string') {
      res.status(400).json({ error: 'path must be a string when provided' });
      return;
    }
    try {
      // Resolve the paths to reject, then run them as ONE locked batch
      // (acquire every lock → restore baselines on disk → one commit + push).
      // Holding the locks before the disk mutation is what keeps a concurrent
      // editor from racing the restores — the route never mutates disk unlocked.
      let paths: string[];
      if (pathParam) {
        // Gate the single path: never let a caller reject a change they can't read.
        if (!(await canReadPath(req.params.id, user.email, pathParam))) {
          res.status(403).json({ error: `You don't have permission to read "${pathParam}".` });
          return;
        }
        paths = [pathParam];
      } else {
        // Reject-all only acts on changes the caller may read.
        const current = await diffService.currentSession(req.params.id);
        paths = await readablePaths(
          req.params.id,
          user.email,
          current?.changes.map((c) => c.path) ?? [],
        );
      }
      await rejectPathsLocked(workflowService, diffService, req.params.id, user, kbDirName, paths);
      res.json({ session: await diffService.currentSession(req.params.id) });
    } catch (err) {
      const { status, body } = toHttpError(err);
      res.status(status).json(body);
    }
  });

  return router;
}
