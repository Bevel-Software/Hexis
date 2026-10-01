import express, { type RequestHandler } from 'express';
import { logger } from '../../shared/logging.js';

const log = logger('write-access');

/**
 * Whether the deployment may be CHANGED right now. The seam a host that
 * sells seats needs for a workspace that has more people on it than its plan
 * allows: nobody is removed and everyone can still sign in and read, but
 * nothing can be edited until an admin brings the count down or the plan up
 * — the way Notion handles a lapsed workspace.
 *
 * Core is always writable. The port is asked on every request that would
 * change something (a mutating HTTP route, a write tool), so a host answers
 * from something cheap — its own cached view of the plan.
 */
export type WriteAccessVerdict = { ok: true } | { ok: false; message: string };

export interface IWriteAccess {
  canWrite(): Promise<WriteAccessVerdict>;
  /**
   * Paths of the host's own routes that must stay usable while the
   * deployment is read-only — above all, the ones that END it (buying
   * seats, the billing portal). Matched as prefixes of the request path.
   */
  readonly alwaysWritablePaths?: readonly string[];
}

/** Core's default: always writable. */
export const alwaysWritable: IWriteAccess = {
  canWrite: async () => ({ ok: true }),
};

/** The `code` a refused write answers with, so a client can tell it from a permission error. */
export const READ_ONLY_CODE = 'workspace_read_only';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * The mutating routes that stay open while the deployment is read-only.
 * EVERY OTHER mutating route under `/api` is refused, so a route added
 * later is read-only until someone decides otherwise — the safe default for
 * a list nobody re-reads when adding a route.
 *
 * What stays open, and why:
 *  - Signing in and out of everything: sessions, agent connections and
 *    their keys. A read-only workspace is still one people read.
 *  - Account administration: the way an admin brings the number of people
 *    down. Erasing an account with `removeFromAccess` commits to the
 *    knowledge base, and that commit is part of the same act.
 *  - The tool surface: every tool call is judged by the tool layer itself,
 *    which knows a read tool from a write tool (see `toolHandler`); the MCP
 *    endpoint only relays to it.
 *  - Deployment setup, tool secrets and pulling remote changes in: the
 *    deployment's configuration, not its content, and what an admin needs
 *    to keep it working.
 *  - Requests that are POST only because they carry a body: permission
 *    queries, previews, probes, focus and heartbeat signals, fetching
 *    remotes, accepting a review baseline. None of them changes content.
 */
const ALWAYS_WRITABLE: readonly RegExp[] = [
  /^\/api\/auth\//,
  /^\/api\/mcp(\/|$)/,
  /^\/api\/agent\//,
  /^\/api\/admin\/accounts(\/|$)/,
  /^\/api\/admin\/connection-keys\//,
  /^\/api\/audit\//,
  /^\/api\/sync(\/|$)/,
  /^\/api\/setup\//,
  /^\/api\/secrets\//,
  /^\/api\/admin\/github-facade\//,
  /^\/api\/workspace\/[^/]+\/access\/batch$/,
  /^\/api\/workspace\/[^/]+\/review\/accept$/,
  /^\/api\/workspace\/[^/]+\/flush$/,
  /^\/api\/workspace\/[^/]+\/workflow\/refresh-remotes$/,
  /^\/api\/workspace\/[^/]+\/workflow\/locks\/heartbeat$/,
  /^\/api\/events\/[^/]+\/focus$/,
  /^\/api\/tools\/preview$/,
];

/** Whether a request may go ahead while the deployment is read-only, without asking. */
export function isAlwaysWritable(method: string, path: string, hostPaths: readonly string[] = []): boolean {
  if (!MUTATING_METHODS.has(method.toUpperCase())) return true;
  if (!path.startsWith('/api/')) return true;
  return ALWAYS_WRITABLE.some((rule) => rule.test(path)) || hostPaths.some((prefix) => path.startsWith(prefix));
}

/**
 * Refuse every change to the deployment while the port says it is
 * read-only, with a 403 the app recognises by {@link READ_ONLY_CODE}.
 * Mounted ahead of every route under `/api`; a request the port is not
 * asked about costs nothing. A port that fails is treated as writable —
 * a billing lookup that is down must not freeze every workspace.
 */
export function createWriteGateMiddleware(writeAccess: IWriteAccess): RequestHandler {
  if (writeAccess === alwaysWritable) return (_req, _res, next) => next();
  return async (req, res, next) => {
    if (isAlwaysWritable(req.method, req.path, writeAccess.alwaysWritablePaths)) return next();
    let verdict: WriteAccessVerdict;
    try {
      verdict = await writeAccess.canWrite();
    } catch (err) {
      log.warn('the write-access port failed; letting the request through:', { err });
      return next();
    }
    if (verdict.ok) return next();
    res.status(403).json({ error: verdict.message, code: READ_ONLY_CODE });
  };
}

/**
 * The verdict for a write tool, the tool layer's half of the gate: `null`
 * when it may run, the refusal otherwise. Same failure rule as the HTTP gate.
 */
export async function refuseWriteTool(writeAccess: IWriteAccess): Promise<string | null> {
  if (writeAccess === alwaysWritable) return null;
  try {
    const verdict = await writeAccess.canWrite();
    return verdict.ok ? null : verdict.message;
  } catch (err) {
    log.warn('the write-access port failed; letting the tool run:', { err });
    return null;
  }
}

/**
 * GET /api/write-access — whether the deployment can be changed right now,
 * and if not, the host's words for why. The app reads it to say so once, in
 * a banner, instead of letting every save fail on its own.
 */
export function createWriteAccessRoutes(writeAccess: IWriteAccess): express.Router {
  const router = express.Router();
  router.get('/write-access', async (_req, res) => {
    try {
      const verdict = await writeAccess.canWrite();
      res.json(verdict.ok ? { writable: true } : { writable: false, message: verdict.message });
    } catch {
      res.json({ writable: true });
    }
  });
  return router;
}
