import express, { type Request, type Response, type RequestHandler } from 'express';
import { logger } from '../../shared/logging.js';

const log = logger('mcp');
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  InvalidTokenLabelError,
  TokenNotFoundError,
  TokenStillActiveError,
} from '../tool-auth/external-api-key.errors.js';
import type { IExternalApiKeyService } from '../tool-auth/external-api-key.interface.js';
import type { InternalTokenService } from '../tool-auth/internal-token.service.js';
import { MCP_LOOPBACK_TOKEN_TTL_MS, type McpService } from './mcp.service.js';
import type { BevelOAuthProvider } from './oauth/bevel-oauth-provider.js';
import type { ILlmUsageMeter } from '../tool-auth/llm-usage-meter.js';
import '../tool-auth/external-api-key.interface.js'; // req.externalApiKeyId augmentation

/** Pull the raw bearer token off an already-authenticated request. */
function extractBearer(req: Request): string {
  const header = req.headers.authorization ?? '';
  const firstSpace = header.indexOf(' ');
  return firstSpace >= 0 ? header.slice(firstSpace + 1).trim() : '';
}

/**
 * `-32000` is the code the MCP SDK's own transport pairs with its 4xx transport
 * refusals (including its 405); ours match it so a client sees one vocabulary.
 */
const TRANSPORT_ERROR = -32000;
/** JSON-RPC 2.0's own code for a fault on our side, used for the 500 catch-all. */
const INTERNAL_ERROR = -32603;

/**
 * Answer in the transport's own wire shape
 * (`{ jsonrpc, error: { code, message }, id: null }`), for the answers this
 * router gives without ever reaching an SDK transport. `id: null` matches the
 * SDK: the request id is not reliably known on a body we may never have parsed
 * as a single message.
 */
function jsonRpcError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null });
}

/**
 * Routes for the remote MCP server + the connection-key management endpoints.
 *
 * Layout:
 *   POST   /mcp           — every client→server MCP message, each request on its own
 *   GET    /mcp           — 405: no standalone server→client stream (stateless)
 *   DELETE /mcp           — 405: there is no session to terminate (stateless)
 *
 *   GET    /mcp/external-api-keys         — list this user's connection keys
 *   POST   /mcp/external-api-keys         — mint a new key (returns plaintext ONCE)
 *   DELETE /mcp/external-api-keys/:id     — revoke
 *
 *   POST   /mcp/local-token               — exchange an MCP OAuth access token
 *                                           for a loopback internal token
 *
 * The `/mcp` POST accepts either a connection key or a JWT/OAuth token (see
 * McpAuthMiddleware). The `/mcp/external-api-keys/*` endpoints accept only the JWT —
 * minting/revoking via a connection key would let a leaked key roll itself
 * over and stay alive forever. `/mcp/local-token` accepts ONLY an MCP OAuth
 * access token — every other credential already opens the surface it bridges to.
 */
export function createMcpRoutes(
  mcpService: McpService,
  externalApiKeyService: IExternalApiKeyService,
  mcpAuthMiddleware: RequestHandler,
  jwtAuthMiddleware: RequestHandler,
  llmUsageService: ILlmUsageMeter,
  internalTokens: InternalTokenService,
  oauthProvider: BevelOAuthProvider,
  // RFC 9728 pointer carried on this router's own 401 challenges (the
  // local-token exchange), same value McpAuthMiddleware advertises.
  resourceMetadataUrl: string,
): express.Router {
  const router = express.Router();

  // ── MCP transport (stateless) ──────────────────────────────────────────

  /**
   * One request, one MCP server, one transport — and nothing kept afterwards.
   *
   * The Streamable HTTP transport makes the session id OPTIONAL: a server that
   * never assigns one (`sessionIdGenerator: undefined`, the SDK's stateless
   * profile) is served by clients that treat every request independently. So
   * there is no `initialize`-first rule, no session to look up, and no
   * "Session not found" to answer: identity, the metering key and the
   * ACL-filtered tool surface all come from THIS request's bearer. A platform
   * restart between two requests of one conversation is therefore invisible —
   * the next request is served exactly as it would have been before it.
   *
   * A stale `Mcp-Session-Id` from a client that connected before this endpoint
   * went stateless is ignored by the stateless transport, not refused.
   *
   * Notifications a request emits (tool-call progress) ride that request's own
   * response stream. The server and transport are closed when the response
   * closes — finished, or abandoned by the client mid-call.
   */
  router.post('/mcp', mcpAuthMiddleware, async (req, res) => {
    let server: Server | undefined;
    res.on('close', () => {
      // Closing the server closes its transport too.
      void server?.close().catch((err) => {
        log.warn('closing a request server failed:', { err });
      });
    });
    try {
      const built = await mcpService.createRequestServer(
        {
          userId: req.userId!,
          // Connection-key id (set by mcpAuthMiddleware for `bevel_…` bearers;
          // undefined for OAuth/JWT) — resolved per request, so per-key metering
          // never depends on anything remembered from an earlier request.
          tokenId: req.externalApiKeyId ?? null,
          // The proxy authenticates its loopback calls with the SAME bearer the
          // client used here, so it acts on the request exactly as the caller would.
          bearer: extractBearer(req),
        },
        req.body,
      );
      // The client gave up while the server was being built: nothing to answer.
      if (res.writableEnded || res.destroyed) {
        await built.close().catch(() => {});
        return;
      }
      server = built;
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      log.error('POST /mcp failed:', { detail: msg });
      if (!res.headersSent) {
        jsonRpcError(res, 500, INTERNAL_ERROR, msg);
      } else {
        res.end();
      }
    }
  });

  /**
   * GET and DELETE are retired, per the stateless profile.
   *
   * GET would open a standalone server→client stream; with no session there is
   * nothing to push on one, and the spec's answer for a server that offers none
   * is 405 — which spec-conformant clients (the SDK's among them) treat as "no
   * stream", not as a failure. DELETE would terminate a session; there is none,
   * and 405 is the spec's answer for a server that does not support it.
   *
   * Deliberately NOT behind the auth middleware: the answer is the same for
   * everyone and reveals nothing, and a 401 here would send an OAuth-capable
   * client into an authorization flow for a stream that does not exist.
   */
  const methodNotAllowed: RequestHandler = (_req, res) => {
    res.setHeader('Allow', 'POST');
    jsonRpcError(res, 405, TRANSPORT_ERROR, 'Method not allowed.');
  };
  router.get('/mcp', methodNotAllowed);
  router.delete('/mcp', methodNotAllowed);

  // ── Connection-key management (JWT-only) ───────────────────────────────

  router.get('/mcp/external-api-keys', jwtAuthMiddleware, async (req, res) => {
    try {
      const tokens = await externalApiKeyService.listForUser(req.userId!);
      // Enrich each key with its LLM-proxy usage today + the daily cap, so the
      // settings UI can show how much of the model budget the key has spent.
      const usage = await llmUsageService.usageForTokens(tokens.map((t) => t.id));
      res.json(
        tokens.map((t) => ({
          ...t,
          llmUsage: {
            usedTodayTokens: usage[t.id] ?? 0,
            dailyTokenCap: llmUsageService.dailyCap,
          },
        })),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      res.status(500).json({ error: msg });
    }
  });

  router.post('/mcp/external-api-keys', jwtAuthMiddleware, async (req, res) => {
    try {
      // `express.json()` leaves req.body undefined when the client posts
      // without `Content-Type: application/json` (or with another type
      // entirely). Destructuring undefined throws a TypeError that the outer
      // catch would 500 — guard with a clean 400 instead.
      if (!req.body || typeof req.body !== 'object') {
        res.status(400).json({ error: 'JSON body required' });
        return;
      }
      const { label } = req.body as { label?: string };
      if (!label) {
        res.status(400).json({ error: 'label is required' });
        return;
      }
      const minted = await externalApiKeyService.mint(req.userId!, label);
      // The plaintext field is the *only* read path for the raw key. The
      // frontend must store it nowhere — it shows the dialog once and then
      // discards. Subsequent fetches return only `summary`-shaped rows.
      res.json(minted);
    } catch (err) {
      if (err instanceof InvalidTokenLabelError) {
        res.status(400).json({ error: err.message });
        return;
      }
      const msg = err instanceof Error ? err.message : 'Unknown error';
      res.status(500).json({ error: msg });
    }
  });

  router.delete('/mcp/external-api-keys/:id', jwtAuthMiddleware, async (req, res) => {
    try {
      await externalApiKeyService.revoke(String(req.params.id), req.userId!);
      res.json({ status: 'revoked' });
    } catch (err) {
      if (err instanceof TokenNotFoundError) {
        res.status(404).json({ error: err.message });
        return;
      }
      const msg = err instanceof Error ? err.message : 'Unknown error';
      res.status(500).json({ error: msg });
    }
  });

  // Hard-delete: permanently remove a *disconnected* key and its audit row.
  // Separate path from revoke so the two lifecycle steps can't be conflated;
  // the service refuses to delete a still-active key (409).
  router.delete('/mcp/external-api-keys/:id/permanent', jwtAuthMiddleware, async (req, res) => {
    try {
      await externalApiKeyService.remove(String(req.params.id), req.userId!);
      res.json({ status: 'deleted' });
    } catch (err) {
      if (err instanceof TokenNotFoundError) {
        res.status(404).json({ error: err.message });
        return;
      }
      if (err instanceof TokenStillActiveError) {
        res.status(409).json({ error: err.message });
        return;
      }
      const msg = err instanceof Error ? err.message : 'Unknown error';
      res.status(500).json({ error: msg });
    }
  });

  // ── Local-server token exchange (OAuth-access-token-only) ──────────────

  /**
   * Exchange an MCP OAuth access token for a short-lived internal token.
   *
   * Why it exists: the LOCAL MCP server's REST reads — the all-tools manual,
   * `list_local_tools`, the plugin archive — live on `/api/agent/*`, which
   * accepts connection keys and internal tokens ONLY; an MCP OAuth access
   * token deliberately 401s there. Hosted OAuth requests cross that gap
   * inside `McpService.createRequestServer`, which mints a loopback internal
   * token for the resolved user. This endpoint is the same exchange for an
   * external caller: the one bridge that lets a local server configured via the
   * deployment's MCP OAuth (instead of a connection key) reach those reads.
   *
   * Why it is NOT a widening of the trust boundary: the caller must present a
   * VERIFIED OAuth grant for this exact user — the same credential that
   * already drives full tool execution through the hosted `/mcp` endpoint.
   * The minted token is identical in shape to the hosted proxy's loopback bearer
   * (`{ userId, externalProxy: true }` → resolved as `source: 'external'` by
   * the tool-auth verifier, admitted to the external surface, refused from
   * internal-only tools) and carries the same TTL — CAPPED to the presented
   * access token's remaining lifetime, so the exchange can never mint a
   * credential that outlives its grant. Nothing becomes reachable that the
   * grant did not already reach — only the credential's spelling changes.
   *
   * Auth semantics mirror McpAuthMiddleware's OAuth branch: an
   * invalid/expired/revoked token is a 401 re-challenging with
   * `resource_metadata` (RFC 9728) so the client can re-authorize; a backend
   * failure during verification is a 500. A connection key, internal token,
   * or JWT is a 403 — those credentials need no exchange, so accepting them
   * here would only manufacture a second credential from a first.
   *
   * Response: `{ token, expiresInMs }`.
   */
  router.post('/mcp/local-token', async (req, res) => {
    const wwwAuthenticate = `Bearer realm="bevel-mcp", resource_metadata="${resourceMetadataUrl}"`;
    const unauthorized = (error: string) => {
      res.setHeader('WWW-Authenticate', wwwAuthenticate);
      res.status(401).json({ error });
    };

    const header = req.headers.authorization;
    if (!header || !header.toLowerCase().startsWith('bearer ')) {
      unauthorized('Missing or invalid Authorization header');
      return;
    }
    const token = extractBearer(req);

    if (!oauthProvider.looksLikeAccessToken(token)) {
      // A recognizable non-OAuth credential gets an explicit 403: a
      // connection key or internal token already opens `/api/agent/*`
      // directly, and a JWT holder mints a connection key from the settings
      // UI — none of them has anything to exchange.
      if (
        externalApiKeyService.looksLikeExternalApiKey(token) ||
        internalTokens.looksLikeInternalToken(token) ||
        token.startsWith('eyJ')
      ) {
        res.status(403).json({
          error:
            'This endpoint exchanges MCP OAuth access tokens only. Connection keys, ' +
            'internal tokens, and JWTs need no exchange — use them directly.',
        });
        return;
      }
      // Unrecognizable bearer — re-challenge so an OAuth-capable client can
      // discover the authorization server and obtain a real access token.
      unauthorized('Invalid access token');
      return;
    }

    try {
      const info = await oauthProvider.verifyAccessToken(token);
      const userId = String(info.extra?.userId ?? '');
      if (!userId) {
        unauthorized('Invalid access token');
        return;
      }
      // The minted token must never OUTLIVE the grant that authorized it: an
      // OAuth access token revoked-by-expiry would otherwise leave a live
      // internal token behind for the rest of the loopback TTL. Bind the TTL
      // to whichever ends first — the constant, or the access token's own
      // remaining lifetime (AuthInfo.expiresAt is epoch SECONDS, optional; a
      // provider that reports none falls back to the constant alone).
      const grantRemainingMs =
        typeof info.expiresAt === 'number' ? info.expiresAt * 1000 - Date.now() : undefined;
      // A grant with no life left mints NOTHING: a 200 carrying an
      // already-dead token would read as success to the caller, whose first
      // real request then fails somewhere far from the cause. It is the same
      // 401 an expired token gets from the verifier, challenge and all — and
      // a non-finite expiresAt (a provider handing back garbage) is refused
      // the same way rather than turned into a TTL. Deliberately STRICTER
      // than the verifier at the boundary: AuthInfo floors the expiry to
      // whole seconds, so a grant inside its final partial second computes
      // as spent here even though the verifier (which compares the stored
      // millisecond timestamp) just accepted it — but that sub-second
      // remainder could only mint a token that is dead before its first use,
      // and refusing it is exactly this guard's job.
      if (grantRemainingMs !== undefined && !(Number.isFinite(grantRemainingMs) && grantRemainingMs > 0)) {
        unauthorized('Invalid, expired, or revoked access token');
        return;
      }
      const ttlMs =
        grantRemainingMs === undefined
          ? MCP_LOOPBACK_TOKEN_TTL_MS
          : Math.min(MCP_LOOPBACK_TOKEN_TTL_MS, grantRemainingMs);
      const minted = internalTokens.mint({ userId, externalProxy: true }, ttlMs);
      // The ACTUAL lifetime, not the constant — the caller schedules its
      // proactive renewal off this number.
      res.json({ token: minted, expiresInMs: ttlMs });
    } catch (err) {
      // Same split as McpAuthMiddleware: a bad token is a clean 401 with the
      // discovery challenge; a backend failure is a 500 — the credential may
      // be fine, we just can't check it right now.
      if (err instanceof InvalidTokenError) {
        unauthorized('Invalid, expired, or revoked access token');
      } else {
        log.error('local-token exchange failed:', { err });
        res.status(500).json({ error: 'Authentication backend unavailable' });
      }
    }
  });

  return router;
}
