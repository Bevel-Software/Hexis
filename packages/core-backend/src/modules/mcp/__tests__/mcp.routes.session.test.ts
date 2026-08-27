import type { Server as HttpServer } from 'node:http';
import type { Request, RequestHandler, Response } from 'express';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMcpRoutes } from '../mcp.routes.js';
import type { IExternalApiKeyService } from '../../tool-auth/external-api-key.interface.js';

/**
 * Session routing on the MCP transport routes — how `/api/mcp` answers a
 * request whose `Mcp-Session-Id` it cannot resolve.
 *
 * The distinction is load-bearing rather than cosmetic. Streamable HTTP makes
 * HTTP 404 on a request bearing a session id the signal a client re-initializes
 * on; 400 means "you sent something malformed", which has no recovery. These
 * routes used to answer both misses — no session id, and a session id from a
 * session that no longer exists — with one 400 on POST and one 404 on
 * GET/DELETE, so a client whose session died with the server (a restart wipes
 * the in-process map) was told its request was malformed and stayed stranded.
 *
 * Locked down here:
 *   - the two misses map to distinct, spec-correct codes on every verb;
 *   - both bodies are real JSON-RPC error objects, since this router answers
 *     before the SDK transport that would otherwise have shaped them;
 *   - an `initialize` carrying a STALE session id still opens a new session —
 *     the recovery path itself, which the old "no session id" guard blocked;
 *   - the live-session and cross-user branches are untouched.
 */

/** The id the FIRST session minted in a test gets; `openSession` establishes it. */
const SESSION_ID = 'sess-1';

/** Auth stand-in: binds the user named by `x-test-user`, defaulting to user-A. */
const fakeAuth: RequestHandler = (req, _res, next) => {
  req.userId = (req.headers['x-test-user'] as string | undefined) ?? 'user-A';
  next();
};

let httpServer: HttpServer | undefined;

afterEach(async () => {
  if (httpServer) {
    await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
    httpServer = undefined;
  }
  vi.restoreAllMocks();
});

/**
 * A createSession stub shaped like the real one: it hands back a transport
 * whose `handleRequest` reports the session id it served, and announces the
 * session through `onSessionInitialized` from INSIDE that first call — which
 * is when the SDK transport really fires it, and the only ordering the route's
 * `active.set` closure can observe without a TDZ error.
 *
 * Each call mints a DISTINCT id (`sess-1`, `sess-2`, …) rather than a constant.
 * With a constant, a route that wrongly minted a second session answered with
 * a body identical to the correct one, so "no second session" could only ever
 * be asserted through the call count. Numbering them puts the mistake in the
 * response itself: a reply naming `sess-2` IS the extra session.
 */
function makeMcpService() {
  let minted = 0;
  const createSession = vi.fn(
    async (
      userId: string,
      _tokenId: string | null,
      _bearer: string,
      onSessionInitialized: (sessionId: string) => void,
    ) => {
      minted += 1;
      const sessionId = `sess-${minted}`;
      let announced = false;
      const transport = {
        sessionId,
        onclose: undefined as undefined | (() => void),
        handleRequest: vi.fn(async (_req: Request, res: Response) => {
          if (!announced) {
            announced = true;
            onSessionInitialized(sessionId);
          }
          res.status(200).json({ forwarded: true, sessionId, userId });
        }),
        close: vi.fn(async () => {}),
      };
      const server = { connect: vi.fn(async () => {}), close: vi.fn(async () => {}) };
      return { transport, server };
    },
  );
  return { onSessionEvicted: () => {}, createSession };
}

async function mount(): Promise<{ baseUrl: string; createSession: ReturnType<typeof vi.fn> }> {
  const mcpService = makeMcpService();
  const stub = {} as never;
  const app = express();
  app.use(express.json());
  app.use(
    '/api',
    createMcpRoutes(
      mcpService as never,
      {} as unknown as IExternalApiKeyService,
      fakeAuth,
      fakeAuth,
      stub,
      stub,
      stub,
      '',
    ),
  );
  httpServer = await new Promise<HttpServer>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = (httpServer.address() as { port: number }).port;
  return { baseUrl: `http://127.0.0.1:${port}`, createSession: mcpService.createSession };
}

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 0,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '0' } },
};
const TOOL_CALL = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };

async function send(
  baseUrl: string,
  opts: { method?: string; sessionId?: string; body?: unknown; user?: string } = {},
): Promise<Response> {
  const { method = 'POST', sessionId, body, user } = opts;
  return fetch(`${baseUrl}/api/mcp`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
      ...(user ? { 'x-test-user': user } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

/** Open a real session so `active` holds SESSION_ID. */
async function openSession(baseUrl: string): Promise<void> {
  const res = await send(baseUrl, { body: INITIALIZE });
  expect(res.status).toBe(200);
}

describe('POST /mcp session routing', () => {
  it('answers an unknown session id with 404 / -32001, the re-initialize signal', async () => {
    const { baseUrl } = await mount();
    const res = await send(baseUrl, { sessionId: 'sess-from-before-the-restart', body: TOOL_CALL });
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Session not found' },
      id: null,
    });
  });

  it('answers a missing session id with 400 / -32000 — a different code from the miss above', async () => {
    const { baseUrl } = await mount();
    const res = await send(baseUrl, { body: TOOL_CALL });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Bad Request: Mcp-Session-Id header is required' },
      id: null,
    });
  });

  it('opens a new session for an initialize that still carries a STALE session id', async () => {
    const { baseUrl, createSession } = await mount();
    // Exactly what a client does after a server restart: it re-initializes
    // before it has any reason to drop the id it was given last time.
    const res = await send(baseUrl, { sessionId: 'sess-from-before-the-restart', body: INITIALIZE });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ forwarded: true, sessionId: SESSION_ID });
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  it('opens a new session for an initialize with no session id', async () => {
    const { baseUrl, createSession } = await mount();
    const res = await send(baseUrl, { body: INITIALIZE });
    expect(res.status).toBe(200);
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  it('forwards to the live transport once a session exists', async () => {
    const { baseUrl, createSession } = await mount();
    await openSession(baseUrl);
    const res = await send(baseUrl, { sessionId: SESSION_ID, body: TOOL_CALL });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ forwarded: true, sessionId: SESSION_ID });
    // No second session: the live branch was taken, not the initialize branch.
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  it('routes an initialize over a LIVE session to that session, minting no second one', async () => {
    // The guard this pins is branch ORDER, and only this change made it
    // load-bearing: `initialize` used to be gated on `!sessionIdHeader`, so
    // the live-session branch and the initialize branch were mutually
    // exclusive and their order did not matter. Without that gate, an
    // initialize check placed first would match here too — and silently mint
    // a second session over a working one, which is the failure the route
    // comment and the PR both promise cannot happen.
    //
    // What is asserted is what this ROUTER owes: the request reached the
    // existing transport and no new session was created. Rejecting a
    // re-initialize is the SDK transport's own job (`-32600 Server already
    // initialized`), and asserting that here would be asserting against the
    // stub rather than against the code under test.
    const { baseUrl, createSession } = await mount();
    await openSession(baseUrl); // mints sess-1
    const res = await send(baseUrl, { sessionId: SESSION_ID, body: INITIALIZE });
    expect(res.status).toBe(200);
    // sess-1, not sess-2: the live transport answered, not a fresh one.
    await expect(res.json()).resolves.toMatchObject({ forwarded: true, sessionId: SESSION_ID });
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  it('still refuses another user’s live session with 403', async () => {
    const { baseUrl } = await mount();
    await openSession(baseUrl); // owned by user-A
    const res = await send(baseUrl, { sessionId: SESSION_ID, body: TOOL_CALL, user: 'user-B' });
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: 'Session does not belong to this user' });
  });
});

describe.each(['GET', 'DELETE'])('%s /mcp session routing', (method) => {
  it('answers an unknown session id with 404 / -32001', async () => {
    const { baseUrl } = await mount();
    const res = await send(baseUrl, { method, sessionId: 'sess-from-before-the-restart' });
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Session not found' },
      id: null,
    });
  });

  it('answers a missing session id with 400 / -32000', async () => {
    const { baseUrl } = await mount();
    const res = await send(baseUrl, { method });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Bad Request: Mcp-Session-Id header is required' },
      id: null,
    });
  });
});
