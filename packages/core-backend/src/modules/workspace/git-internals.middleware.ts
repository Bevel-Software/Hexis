import express from 'express';
import { GitInternalsError } from '../../shared/domain-errors.js';
import { domainErrorBody } from '../../shared/http-errors.js';
import { assertNotGitInternals, hasGitInternalsSegment } from '../../shared/git-internals.js';
import '../auth/auth.middleware.js'; // Express Request augmentation

/** The query and body fields through which a workspace route names a path. */
const GIT_GUARDED_QUERY_KEYS = ['path', 'toDir'] as const;
// `paths` is the access batch's list; `ancestor` is the folder a
// remove-from-parent cascades up to. Both name workspace paths, so both are
// judged — a field that names a path and is not here is a way around this.
const GIT_GUARDED_BODY_KEYS = ['path', 'oldPath', 'newPath', 'destination', 'paths', 'ancestor'] as const;
/**
 * `from` names a PATH on the prospective-access route (`?from=<file>&toDir=…`)
 * and a BRANCH on the workflow comparison (`?from=<branch>`), so it is judged
 * only where it is a path — a branch called after the git folder is refused
 * by the branch-name rule, not by this one.
 */
const PATH_FROM_ROUTE = /\/access\/prospective\/?$/;

/** Every workspace path a request names, array-shaped queries included. */
export function gitGuardedInputs(req: express.Request): string[] {
  const out: string[] = [];
  const add = (value: unknown) => {
    for (const v of Array.isArray(value) ? value : [value]) if (typeof v === 'string' && v.length > 0) out.push(v);
  };
  const query = req.query as Record<string, unknown>;
  for (const key of GIT_GUARDED_QUERY_KEYS) add(query[key]);
  if (PATH_FROM_ROUTE.test(req.path)) add(query.from);
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
 * points into the folder gets the same refusal.
 *
 * Every spelling is refused whether or not the caller is authenticated — the
 * lexical rule reads the caller's own string and touches no disk, so it
 * answers nothing about the workspace. Only the RESOLVED check waits for
 * `req.userId`: it resolves a workspace directory, which an unauthenticated
 * request must not make the server do.
 *
 * Mounted at the app, ahead of every router under that prefix — the file
 * routes, the review routes, the workflow and access ones, and whatever an
 * extension mounts — so a router added later is covered by the fact of its
 * prefix rather than by remembering this. The services underneath refuse
 * again on their own; this is what keeps the refusal ahead of the gates.
 */
export function createGitInternalsRouteGuard(workspaceService: {
  getWorkspacePath(workspaceId: string): Promise<string>;
}): express.RequestHandler {
  return async (req, res, next) => {
    const inputs = gitGuardedInputs(req);
    if (inputs.length === 0) return next();
    // Only the git refusal reaches here, and it carries its own 403 and its
    // one sanitized message — nothing else about the path is answered.
    const refuse = (err: GitInternalsError) => void res.status(err.status).json(domainErrorBody(err));
    if (inputs.some(hasGitInternalsSegment)) return refuse(new GitInternalsError());
    // The resolved check resolves a workspace on disk, which an
    // unauthenticated request must not make the server do; its route answers
    // that request with its own 401.
    if (!req.userId) return next();
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
