import express, { type Request, type Response, type RequestHandler } from 'express';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
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

interface ActiveSession {
  transport: StreamableHTTPServerTransport;
  server: Server;
  userId: string;
}

/** Pull the raw bearer token off an already-authenticated request. */
function extractBearer(req: Request): string {
  const header = req.headers.authorization ?? '';
  const firstSpace = header.indexOf(' ');
  return firstSpace >= 0 ? header.slice(firstSpace + 1).trim() : '';
}

/**
 * The two JSON-RPC codes the Streamable HTTP transport defines for a session
 * fault, paired with the HTTP status each rides on.
 *
 * `SESSION_NOT_FOUND` (404) is the one that carries meaning to a client: the
 * spec makes a 404 on a request bearing an `Mcp-Session-Id` the trigger to
 * start a new session with a fresh `initialize`. `BAD_REQUEST` (400) is the
 * client-side mistake — a non-initialize request that never carried a session
 * id at all — and has no recovery, because there is nothing to recover.
 */
const SESSION_NOT_FOUND = -32001;
const BAD_REQUEST = -32000;

/**
 * Answer in the transport's own wire shape
 * (`{ jsonrpc, error: { code, message }, id: null }`).
 *
 * These misses are caught by THIS router, one layer before the request would
 * have reached an SDK transport, so the router has to speak the transport's
 * language itself — a client that parses the body as JSON-RPC must not get a
 * bare `{ error }` blob just because we answered early. `id: null` matches the
 * SDK: the request id is not reliably known on a body we may never have
 * parsed as a single message.
 */
function jsonRpcError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null });
}

/**
 * Routes for the remote MCP server + the connection-key management endpoints.
 *
 * Layout:
 *   POST   /mcp           — client→server MCP messages (initialize + tool calls)
 *   GET    /mcp           — server→client SSE channel (session-bound)
 *   DELETE /mcp           — terminate a session
 *
 *   GET    /mcp/external-api-keys         — list this user's connection keys
 *   POST   /mcp/external-api-keys         — mint a new key (returns plaintext ONCE)
 *   DELETE /mcp/external-api-keys/:id     — revoke
 *
 *   POST   /mcp/local-token               — exchange an MCP OAuth access token
 *                                           for a loopback internal token
 *
 * The `/mcp` endpoints accept either a connection key or a JWT (see
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

  // Per-process map of live MCP sessions. In-memory mirror of McpSessionStore
  // — McpSessionStore holds the *domain* state (userId, threadId, idle TTL),
  // this map holds the *transport* state (the SDK objects we need to route
  // a subsequent HTTP request to the correct session). Both are cleared on
  // restart; clients re-initialize.
  const active = new Map<string, ActiveSession>();

  // When McpSessionStore drops a session on its own (idle-TTL sweep or
  // size-cap eviction), the matching transport pair would otherwise leak
  // here — `active.has(id)` would still return true and route requests to a
  // McpServer whose backing domain state is gone. Subscribe to the store and
  // tear down the transport so the resources free immediately and the next
  // request with that id correctly 404s.
  mcpService.onSessionEvicted((sessionId) => {
    const entry = active.get(sessionId);
    if (!entry) return;
    active.delete(sessionId);
    // close() is async; fire-and-forget so a slow socket teardown can't
    // block the store's eviction loop. transport.onclose still fires but
    // its `active.delete` is now a no-op.
    void entry.transport.close().catch((err) => {
      console.warn('[mcp] transport close on eviction failed:', err);
    });
  });

  // ── MCP transport ──────────────────────────────────────────────────────

  router.post('/mcp', mcpAuthMiddleware, async (req, res) => {
    try {
      const sessionIdHeader = req.headers['mcp-session-id'] as string | undefined;
      const body = req.body;

      // Four request shapes on POST /mcp, in this order:
      //  1. Session id naming a live session → forward to its transport.
      //  2. An initialize body → spin up a new transport, whatever stale
      //     session id the client still has attached.
      //  3. A session id we have no transport for → 404 (`-32001`).
      //  4. No session id on a non-initialize request → 400 (`-32000`).
      if (sessionIdHeader && active.has(sessionIdHeader)) {
        const session = active.get(sessionIdHeader)!;
        // Defense in depth: the auth middleware bound a userId for this
        // request; refuse if it doesn't match the session's owner. Stops
        // a leaked session id from being used cross-user even if the
        // attacker has their own valid connection key.
        if (session.userId !== req.userId) {
          res.status(403).json({ error: 'Session does not belong to this user' });
          return;
        }
        await session.transport.handleRequest(req, res, body);
        return;
      }

      // An initialize starts a fresh session even when the client is STILL
      // sending a stale `mcp-session-id`. Requiring the header to be absent
      // deadlocked exactly the client this endpoint most needs to let back in:
      // one whose session died with the server and that re-initializes without
      // first clearing the id — it got the catch-all below forever. The SDK's
      // own transport orders the two checks this way for the same reason:
      // initialize is never session-validated. A LIVE session id is still
      // caught by the branch above, so re-initializing over a working session
      // stays the SDK's `-32600 Server already initialized`, not a silent
      // second session.
      if (isInitializeRequest(body)) {
        // The proxy authenticates its loopback calls with the SAME bearer the
        // client used here, so it acts on the request exactly as the caller
        // would. Captured at initialize and seeded into the session's UtcpClient.
        const { transport, server } = await mcpService.createSession(
          req.userId!,
          // Connection-key id (set by mcpAuthMiddleware for `bevel_…` bearers;
          // undefined for browser JWT) — kept for audit/diagnostics.
          req.externalApiKeyId ?? null,
          extractBearer(req),
          (sessionId) => {
            active.set(sessionId, { transport, server, userId: req.userId! });
          },
        );
        // Closing the transport (DELETE /mcp, or client disconnect during
        // close) should drop both the active map and the McpSessionStore
        // entry. McpService wired onsessionclosed → sessionStore.delete; we
        // mirror it here.
        transport.onclose = () => {
          if (transport.sessionId) active.delete(transport.sessionId);
        };
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
        return;
      }

      // A session id we hold no transport for: the store evicted it, or the
      // process restarted and this in-memory map went with it. 404 + `-32001`
      // is what the spec reserves for that, and it is the signal a client keys
      // its re-initialize on. Answering 400 here read as "you sent a malformed
      // request" and stranded the client on a session that can never come
      // back — every connected agent, on every restart, until a human
      // reconnected it by hand.
      if (sessionIdHeader) {
        jsonRpcError(res, 404, SESSION_NOT_FOUND, 'Session not found');
        return;
      }

      // No session id at all on a non-initialize request: the one case here
      // that genuinely is the caller's mistake, and the only one 400 fits.
      jsonRpcError(res, 400, BAD_REQUEST, 'Bad Request: Mcp-Session-Id header is required');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      console.error('[mcp] POST /mcp failed:', msg);
      if (!res.headersSent) {
        res.status(500).json({ error: msg });
      } else {
        res.end();
      }
    }
  });

  const sessionRequest: RequestHandler = async (req, res) => {
    const sessionIdHeader = req.headers['mcp-session-id'] as string | undefined;
    // Same split as POST, mirrored: a request that never carried a session id
    // is the caller's mistake (400), while one naming a session we no longer
    // hold is the re-initialize signal (404). These were a single 404 — right
    // for the case that matters, wrong for the other, and neither of them
    // parseable as JSON-RPC.
    if (!sessionIdHeader) {
      jsonRpcError(res, 400, BAD_REQUEST, 'Bad Request: Mcp-Session-Id header is required');
      return;
    }
    if (!active.has(sessionIdHeader)) {
      jsonRpcError(res, 404, SESSION_NOT_FOUND, 'Session not found');
      return;
    }
    const session = active.get(sessionIdHeader)!;
    if (session.userId !== req.userId) {
      res.status(403).json({ error: 'Session does not belong to this user' });
      return;
    }
    try {
      await session.transport.handleRequest(req, res);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      console.error('[mcp] session request failed:', msg);
      if (!res.headersSent) res.status(500).json({ error: msg });
      else res.end();
    }
  };

  // GET is the server→client SSE channel for session-scoped notifications.
  router.get('/mcp', mcpAuthMiddleware, sessionRequest);

  // DELETE terminates the session — SDK closes the transport, our
  // onclose handler cleans up the active map, and McpService's
  // onsessionclosed clears the McpSessionStore entry.
  router.delete('/mcp', mcpAuthMiddleware, sessionRequest);

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
   * token deliberately 401s there. Hosted OAuth sessions cross that gap
   * inside `McpService.createSession`, which mints a loopback internal token
   * for the resolved user. This endpoint is the same exchange for an external
   * caller: the one bridge that lets a local server configured via the
   * deployment's MCP OAuth (instead of a connection key) reach those reads.
   *
   * Why it is NOT a widening of the trust boundary: the caller must present a
   * VERIFIED OAuth grant for this exact user — the same credential that
   * already drives full tool execution through the hosted `/mcp` endpoint.
   * The minted token is identical in shape to createSession's loopback bearer
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
        console.error('[mcp] local-token exchange failed:', err);
        res.status(500).json({ error: 'Authentication backend unavailable' });
      }
    }
  });

  return router;
}
