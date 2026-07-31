import express, { type Request, type RequestHandler } from 'express';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  InvalidTokenLabelError,
  TokenNotFoundError,
  TokenStillActiveError,
} from '../tool-auth/external-api-key.errors.js';
import type { IExternalApiKeyService } from '../tool-auth/external-api-key.interface.js';
import type { McpService } from './mcp.service.js';
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
 * The `/mcp` endpoints accept either a connection key or a JWT (see
 * McpAuthMiddleware). The `/mcp/external-api-keys/*` endpoints accept only the JWT —
 * minting/revoking via a connection key would let a leaked key roll itself
 * over and stay alive forever.
 */
export function createMcpRoutes(
  mcpService: McpService,
  externalApiKeyService: IExternalApiKeyService,
  mcpAuthMiddleware: RequestHandler,
  jwtAuthMiddleware: RequestHandler,
  llmUsageService: ILlmUsageMeter,
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

      // Three valid request shapes on POST /mcp:
      //  1. No session id + body is initialize → spin up a new transport.
      //  2. Session id + matching active session → forward.
      //  3. Anything else → 400 / 404.
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

      if (!sessionIdHeader && isInitializeRequest(body)) {
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

      res.status(400).json({
        error:
          'Bad request: missing session id, or session id does not match any active session.',
      });
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
    if (!sessionIdHeader || !active.has(sessionIdHeader)) {
      res.status(404).json({ error: 'Unknown MCP session' });
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

  return router;
}
