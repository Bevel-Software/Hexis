import type { Request, Response, NextFunction } from 'express';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { AuthService } from '../auth/auth.service.js';
import type { IExternalApiKeyService } from '../tool-auth/external-api-key.interface.js';
import type { InternalTokenService } from '../tool-auth/internal-token.service.js';
import type { BevelOAuthProvider } from './oauth/bevel-oauth-provider.js';
import '../tool-auth/external-api-key.interface.js'; // Express Request augmentation (req.externalApiKeyId)

/**
 * Auth middleware for the MCP endpoint. Accepts any of:
 *
 *   1. A connection key (Bearer `bevel_…`) — minted from the settings UI,
 *      resolved via ExternalApiKeyService.
 *   2. An MCP OAuth access token (Bearer `bevel-mcp_…`) — issued by our own
 *      authorization server after the /connect consent flow, resolved via
 *      BevelOAuthProvider.
 *   3. An internal token (Bearer `<tenant>-int_…`) — minted server-side only
 *      (createSession's loopback bearer, the /mcp/local-token exchange). The
 *      local MCP server (hexis-mcp) exchanges its OAuth grant for one and
 *      then uses it EVERYWHERE a connection key goes — the agent REST surface
 *      already accepts it, and refusing it here made OAuth-mode hexis-mcp
 *      fail at exactly one hop: registering this endpoint as its remote
 *      manual. Accepting it adds no new mint path — only this server creates
 *      them, always for an already-verified user.
 *   4. A regular JWT — same shape the web app uses. Lets a logged-in user
 *      hit the MCP endpoint from their browser if we ever need it
 *      (e.g. an in-app debugger). Keeps the surface from forking.
 *
 * The middleware **must** run before the MCP transport handler — the
 * transport pulls `req.userId` to populate the session row at `initialize`.
 *
 * Failures return 401 with a `WWW-Authenticate` challenge carrying
 * `resource_metadata` (RFC 9728) so an OAuth-capable MCP client discovers our
 * authorization server and starts the flow, while clients configured with a
 * key simply prompt for it.
 */
export function createMcpAuthMiddleware(
  authService: AuthService,
  externalApiKeyService: IExternalApiKeyService,
  oauthProvider: BevelOAuthProvider,
  resourceMetadataUrl: string,
  internalTokens: InternalTokenService,
) {
  const wwwAuthenticate = `Bearer realm="bevel-mcp", resource_metadata="${resourceMetadataUrl}"`;
  const unauthorized = (res: Response, error: string) => {
    res.setHeader('WWW-Authenticate', wwwAuthenticate);
    res.status(401).json({ error });
  };

  return async (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    // RFC 7235 §2.1: auth scheme matching is case-insensitive ("bearer",
    // "BEARER", "BeArEr" are all valid). Match on the lowercased prefix and
    // then take the token as whatever follows the first whitespace, so the
    // extraction stays correct regardless of the caller's casing.
    if (!header || !header.toLowerCase().startsWith('bearer ')) {
      unauthorized(res, 'Missing or invalid Authorization header');
      return;
    }

    const firstSpace = header.indexOf(' ');
    const token = header.slice(firstSpace + 1).trim();

    // Route on the tenant key prefixes so we never accidentally pass a JWT
    // through hash lookup or an external API key through jsonwebtoken — both
    // would 500 instead of cleanly 401-ing. Order matters only for clarity:
    // the connection-key (`bevel_`), OAuth (`bevel-mcp_`), and JWT (`eyJ…`)
    // shapes are mutually non-overlapping.
    if (externalApiKeyService.looksLikeExternalApiKey(token)) {
      try {
        // Resolve the token *id* alongside the user so the tool handler can
        // meter the internal model against this key's daily cap — the same
        // per-key guardrail the LLM proxy enforces. OAuth and JWT callers
        // have no connection key, so those paths below leave
        // `externalApiKeyId` unset and are not metered.
        const resolved = await externalApiKeyService.verifyAndLoadToken(token);
        if (!resolved) {
          unauthorized(res, 'Invalid or revoked connection key');
          return;
        }
        req.userId = resolved.user.id;
        req.userEmail = resolved.user.email;
        req.externalApiKeyId = resolved.tokenId;
        next();
        return;
      } catch (err) {
        // A DB error during verification is a 500, not a 401 — the caller's
        // credentials may be valid; we just can't check them right now.
        console.error('[mcp-auth] connection-key verification failed:', err);
        res.status(500).json({ error: 'Authentication backend unavailable' });
        return;
      }
    }

    // MCP OAuth access token — issued by our own authorization server. An
    // invalid/expired/revoked token is a clean 401 (re-challenging with
    // resource_metadata so the client can re-authorize); a DB failure is a
    // 500, same split as the connection-key branch above.
    if (oauthProvider.looksLikeAccessToken(token)) {
      try {
        const info = await oauthProvider.verifyAccessToken(token);
        req.userId = String(info.extra?.userId ?? '');
        req.userEmail = String(info.extra?.userEmail ?? '');
        if (!req.userId) {
          unauthorized(res, 'Invalid access token');
          return;
        }
      } catch (err) {
        if (err instanceof InvalidTokenError) {
          unauthorized(res, 'Invalid, expired, or revoked access token');
        } else {
          console.error('[mcp-auth] OAuth token verification failed:', err);
          res.status(500).json({ error: 'Authentication backend unavailable' });
        }
        return;
      }
      // Outside the try so a synchronous throw from a downstream handler isn't
      // misclassified as a token-verification failure (and doesn't try to write
      // a second response).
      next();
      return;
    }

    // Internal token — server-minted, shape-routed like the branches above so
    // it never reaches jsonwebtoken. `verify` returns null for invalid or
    // expired ones (a clean 401); the user row is loaded so `req.userEmail`
    // carries the same truth every other branch provides — the tool handlers
    // downstream resolve access against it.
    if (internalTokens.looksLikeInternalToken(token)) {
      const claim = internalTokens.verify(token);
      if (!claim) {
        unauthorized(res, 'Invalid or expired internal token');
        return;
      }
      let user;
      try {
        user = await authService.getUserById(claim.userId);
      } catch (err) {
        console.error('[mcp-auth] internal-token user lookup failed:', err);
        res.status(500).json({ error: 'Authentication backend unavailable' });
        return;
      }
      if (!user) {
        unauthorized(res, 'Invalid or expired internal token');
        return;
      }
      req.userId = user.id;
      req.userEmail = user.email;
      next();
      return;
    }

    // JWT path — same logic as `createAuthMiddleware` in modules/auth, kept
    // duplicated rather than imported because that one writes its own 401
    // body shape and we want the WWW-Authenticate header set.
    try {
      const { userId, email } = authService.verifyToken(token);
      req.userId = userId;
      req.userEmail = email;
      next();
    } catch {
      unauthorized(res, 'Invalid or expired token');
    }
  };
}
