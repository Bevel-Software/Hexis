import express from 'express';
import { GitInternalsError } from '../../shared/domain-errors.js';
import { domainErrorBody } from '../../shared/http-errors.js';
import { assertNotGitInternals, hasGitInternalsSegment } from '../../shared/git-internals.js';
import '../auth/auth.middleware.js'; // Express Request augmentation

/** The query and body fields through which a workspace route names a path. */
const GIT_GUARDED_QUERY_KEYS = ['path'] as const;
const GIT_GUARDED_BODY_KEYS = ['path', 'oldPath', 'newPath', 'destination'] as const;

/** Every workspace path a request names, array-shaped queries included. */
export function gitGuardedInputs(req: express.Request): string[] {
  const out: string[] = [];
  const add = (value: unknown) => {
    for (const v of Array.isArray(value) ? value : [value]) if (typeof v === 'string' && v.length > 0) out.push(v);
  };
  const query = req.query as Record<string, unknown>;
  for (const key of GIT_GUARDED_QUERY_KEYS) add(query[key]);
  const body = req.body as unknown;
  if (body && typeof body === 'object' && !Buffer.isBuffer(body)) {
    for (const key of GIT_GUARDED_BODY_KEYS) add((body as Record<string, unknown>)[key]);
  }
  return out;
}

/**
 * The git folder is never reachable through the `/workspace/:id` surface (see
 * `shared/git-internals.ts`). Checked once, ahead of every route, on each
 * input that names a workspace path: before the read gate, which would
 * otherwise answer differently for a path that exists, and before any lock is
 * taken. The resolved form is judged too, so a link in the repository that
 * points into the folder gets the same refusal. An unauthenticated request
 * passes through to its route's own 401, and resolves nothing.
 *
 * Mounted ONCE at the app, ahead of every router under that prefix — the file
 * routes, the review routes, the workflow ones — so a router added later is
 * covered by the fact of its prefix rather than by remembering this. The
 * services underneath refuse again on their own; this is what keeps the
 * refusal ahead of the gates.
 */
export function createGitInternalsRouteGuard(workspaceService: {
  getWorkspacePath(workspaceId: string): Promise<string>;
}): express.RequestHandler {
  return async (req, res, next) => {
    const inputs = gitGuardedInputs(req);
    if (inputs.length === 0 || !req.userId) return next();
    // Only the git refusal reaches here, and it carries its own 403 and its
    // one sanitized message — nothing else about the path is answered.
    const refuse = (err: GitInternalsError) => void res.status(err.status).json(domainErrorBody(err));
    if (inputs.some(hasGitInternalsSegment)) return refuse(new GitInternalsError());
    let workspaceDir: string;
    try {
      workspaceDir = await workspaceService.getWorkspacePath(req.params.id as string);
    } catch {
      // The route resolves the workspace again and reports its own failure.
      return next();
    }
    try {
      for (const input of inputs) await assertNotGitInternals(workspaceDir, input);
    } catch (err) {
      if (err instanceof GitInternalsError) return refuse(err);
      throw err;
    }
    next();
  };
}
