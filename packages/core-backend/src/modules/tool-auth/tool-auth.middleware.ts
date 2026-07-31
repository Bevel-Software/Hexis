import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { IExternalApiKeyService } from './external-api-key.interface.js';
import type { AuthService } from '../auth/auth.service.js';
import { InternalTokenService } from './internal-token.service.js';

/**
 * What the `toolAuth` middleware resolves a bearer to, before the per-call
 * `ToolContext` is built. Internal and external are now the SAME shape — a user
 * identity at write scope — resolving through one path; `source` only records
 * which credential authenticated (so internal-only routes can be gated):
 *  - `external`: a `bevel_…` connection key → user.
 *  - `internal`: an identity-only HMAC token minted for an agent's code-mode client.
 *  - `session`: a browser JWT — admitted ONLY on the read-only manual endpoint
 *    (`createManualAuthMiddleware`), never on a tool-execution route, so it can
 *    browse the catalog but cannot invoke tools.
 * The workspace is chosen per call from the tool's `branch` argument (downstream
 * ACL / protected-branch checks gate writes).
 */
export interface ToolAuth {
  source: 'internal' | 'external' | 'session';
  userId: string;
  tokenId?: string;
  /** The agent run id carried by a per-run internal token (in-process agent). The external path supplies `sessionId` on the tool body instead. */
  sessionId?: string;
  /** Always `'write'` now (the middleware sets it for both internal + external — neither credential carries scope). The read path is dormant until consumer agents are removed. */
  scope: 'read' | 'write';
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      toolAuth?: ToolAuth;
    }
  }
}

const WWW_AUTH = 'Bearer realm="bevel-tools"';

/**
 * Gate that admits ONLY in-process callers (those bearing an internal HMAC
 * token). Mount it AFTER `toolAuth` on every internal-only surface — the
 * internal tool catalog and the routes of tools registered with
 * `registerInternalTool` but NOT `registerExternalTool` (e.g. `execute_command`,
 * `switch_branch`, the `sharepoint_*` reads). `toolAuth` alone is not enough:
 * an external connection key authenticates successfully, so without this gate it
 * could invoke an internal-only route directly by guessing its name. The route
 * MUST stay mounted (our own agent reaches it over the same loopback HTTP), so
 * the restriction has to be enforced here at request time, not by hiding the
 * route. 403 (authenticated, but not authorized for this surface).
 */
export const requireInternalSource: RequestHandler = (req, res, next) => {
  if (req.toolAuth?.source !== 'internal') {
    res.status(403).json({ error: 'This tool is internal-only.' });
    return;
  }
  next();
};

/**
 * Mirror of `requireInternalSource` for surfaces that must admit ONLY external
 * callers. `start_session` mints a fresh chat thread as the caller's
 * ontology-session id; an internal (in-process agent) token already carries
 * its run's `sessionId`, so letting it mint a new thread mid-run would
 * silently reset the one-ontology-per-conversation boundary.
 *
 * "External" is decided by the VERIFIER, not by which credential shape
 * authenticated: a `bevel_…` connection key resolves external, and so does an
 * `externalProxy` internal token — the loopback identity the MCP proxy mints
 * for an OAuth/JWT MCP session, whose caller IS an external agent. (Gating on
 * the raw credential shape used to 403 those sessions here, deadlocking them:
 * they couldn't mint a sessionId, and every session-gated tool demands one.)
 * Mount AFTER `toolAuth`. 403 (authenticated, but not authorized).
 */
export const requireExternalSource: RequestHandler = (req, res, next) => {
  if (req.toolAuth?.source !== 'external') {
    res.status(403).json({ error: 'This tool is external-only.' });
    return;
  }
  next();
};

/** Outcome of verifying a bearer token — either a normalized identity or a status+message to surface. */
export type VerifyResult =
  | { ok: true; auth: ToolAuth }
  | { ok: false; status: number; message: string };

/**
 * The framework-agnostic verify core: bearer token (the value AFTER `Bearer `) →
 * normalized `ToolAuth`, accepting EITHER a `bevel_…` connection key (external —
 * pipeline-agent, MCP) OR an internal HMAC token (our own agent's loopback). A
 * bare JWT / unknown scheme is refused. Throws only if the connection-key store
 * itself errors (backend down); the caller maps that to 500. This is the shared
 * primitive both `createToolAuthMiddleware` (our Express hosting) and
 * `validateToken` (the tool-author SDK) are built on, so there is ONE auth path.
 */
export function createTokenVerifier(
  externalApiKeyService: IExternalApiKeyService,
  internalTokenService: InternalTokenService,
): (token: string | undefined) => Promise<VerifyResult> {
  const missing = { ok: false as const, status: 401, message: 'A connection key or internal token is required' };
  return async (token) => {
    if (!token) return missing;

    // Internal token → in-process loopback caller. Usually our own agent
    // (source 'internal'), EXCEPT the `externalProxy` tokens the MCP proxy
    // mints as the loopback identity of an OAuth/JWT MCP session — that
    // caller is an external agent and resolves as one, so external-only
    // surfaces admit it and internal-only surfaces refuse it, exactly like a
    // connection key (it just has no tokenId to meter on).
    if (internalTokenService.looksLikeInternalToken(token)) {
      const claim = internalTokenService.verify(token);
      if (!claim) return { ok: false, status: 401, message: 'Invalid or expired internal token' };
      return claim.externalProxy
        ? { ok: true, auth: { source: 'external', userId: claim.userId, scope: 'write' } }
        : { ok: true, auth: { source: 'internal', userId: claim.userId, sessionId: claim.sessionId, scope: 'write' } };
    }

    // External API key → external caller. (verifyAndLoadToken may throw → propagates → caller maps to 500.)
    if (externalApiKeyService.looksLikeExternalApiKey(token)) {
      const resolved = await externalApiKeyService.verifyAndLoadToken(token);
      return resolved
        ? { ok: true, auth: { source: 'external', userId: resolved.user.id, tokenId: resolved.tokenId, scope: 'write' } }
        : { ok: false, status: 401, message: 'Invalid or revoked connection key' };
    }

    return missing;
  };
}

/**
 * The one auth gate every tool endpoint applies — a THIN Express adapter over
 * `createTokenVerifier`: parse the bearer header, run the shared verify core,
 * normalize the result to `req.toolAuth` (or the matching status). All auth logic
 * lives in the verifier; this only does header parsing + HTTP mapping.
 */
export function createToolAuthMiddleware(
  externalApiKeyService: IExternalApiKeyService,
  internalTokenService: InternalTokenService,
): RequestHandler {
  const verify = createTokenVerifier(externalApiKeyService, internalTokenService);
  return async (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    if (!header || !header.toLowerCase().startsWith('bearer ')) {
      res.setHeader('WWW-Authenticate', WWW_AUTH);
      res.status(401).json({ error: 'Missing or invalid Authorization header' });
      return;
    }
    const token = header.slice(header.indexOf(' ') + 1).trim();
    try {
      const result = await verify(token);
      if (!result.ok) {
        if (result.status === 401) res.setHeader('WWW-Authenticate', WWW_AUTH);
        res.status(result.status).json({ error: result.message });
        return;
      }
      req.toolAuth = result.auth;
      next();
    } catch (err) {
      console.error('[tools] connection-key verification failed:', err);
      res.status(500).json({ error: 'Authentication backend unavailable' });
    }
  };
}

/**
 * Auth gate for the READ-ONLY discovery manuals (`GET /agent/utcp` +
 * `/agent/internal/utcp`) ONLY. Superset of `createToolAuthMiddleware`: it
 * accepts a `bevel_…` connection key, an internal token, OR a browser JWT —
 * the last resolving to `source: 'session'`. This is what lets a logged-in user
 * browse the catalog with their existing session (the manual is just a spec, no
 * secrets, and may become per-user — hence one user-aware endpoint rather than a
 * parallel route). It is deliberately NOT used on tool-execution routes, so a
 * JWT can read the manual but can never invoke a tool. The internal manual stays
 * `requireInternalSource`-gated downstream, so a session/key is 403'd there.
 */
export function createManualAuthMiddleware(
  externalApiKeyService: IExternalApiKeyService,
  internalTokenService: InternalTokenService,
  authService: AuthService,
): RequestHandler {
  const verify = createTokenVerifier(externalApiKeyService, internalTokenService);
  return async (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    if (!header || !header.toLowerCase().startsWith('bearer ')) {
      res.setHeader('WWW-Authenticate', WWW_AUTH);
      res.status(401).json({ error: 'Missing or invalid Authorization header' });
      return;
    }
    const token = header.slice(header.indexOf(' ') + 1).trim();

    // An external API key / internal token goes through the shared verify core.
    if (internalTokenService.looksLikeInternalToken(token) || externalApiKeyService.looksLikeExternalApiKey(token)) {
      try {
        const result = await verify(token);
        if (!result.ok) {
          if (result.status === 401) res.setHeader('WWW-Authenticate', WWW_AUTH);
          res.status(result.status).json({ error: result.message });
          return;
        }
        req.toolAuth = result.auth;
        next();
      } catch (err) {
        console.error('[tools] connection-key verification failed:', err);
        res.status(500).json({ error: 'Authentication backend unavailable' });
      }
      return;
    }

    // Otherwise treat the bearer as a browser session JWT.
    try {
      const { userId } = authService.verifyToken(token);
      req.toolAuth = { source: 'session', userId, scope: 'write' };
      next();
    } catch {
      res.setHeader('WWW-Authenticate', WWW_AUTH);
      res.status(401).json({ error: 'Invalid or expired token' });
    }
  };
}
