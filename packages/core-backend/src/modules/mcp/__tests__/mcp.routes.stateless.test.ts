import { afterEach, describe, expect, it, vi } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { McpCaller } from '../mcp.service.js';
import { closeMountedRoutes, mountMcpRoutes } from './mcp-routes-harness.js';

/**
 * The transport routes of the STATELESS MCP endpoint — what `/api/mcp` owes a
 * request, independent of the proxy behind it.
 *
 * Locked down here:
 *   - no request is ever answered with a session id, and none is ever refused
 *     for lacking one or for carrying one the process does not know;
 *   - every request gets its OWN server, built from THAT request's caller, and
 *     the server is closed once the response is done — nothing outlives it;
 *   - GET and DELETE are retired with 405, never reaching the proxy;
 *   - a failure building the server is a JSON-RPC 500, not a hung request.
 *
 * The service is a stand-in whose `createRequestServer` returns a REAL SDK
 * `Server`, so what is asserted is the route driving a real stateless
 * transport, not a mock's idea of one.
 */

afterEach(async () => {
  await closeMountedRoutes();
  vi.restoreAllMocks();
});

/** A stand-in service: each server lists one tool named after the caller it was built for. */
function makeMcpService() {
  const servers: Array<{ caller: McpCaller; close: ReturnType<typeof vi.spyOn> }> = [];
  const createRequestServer = vi.fn(async (caller: McpCaller) => {
    const server = new Server({ name: 'stub', version: '0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name: `for-${caller.userId}`, inputSchema: { type: 'object' as const } }],
    }));
    servers.push({ caller, close: vi.spyOn(server, 'close') });
    return server;
  });
  return { createRequestServer, servers };
}

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 0,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '0' } },
};
const TOOLS_LIST = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };

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

/** The JSON-RPC messages in a response body, whether it came back as SSE or JSON. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw JSON-RPC bodies, read by shape
async function messagesOf(res: Response): Promise<Array<{ result?: any; error?: any }>> {
  const text = await res.text();
  if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    return text
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => JSON.parse(line.slice('data:'.length)));
  }
  return [JSON.parse(text)];
}

async function waitFor(assertion: () => void): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      assertion();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  assertion();
}

describe('POST /mcp (stateless)', () => {
  it('answers initialize without ever issuing a session id', async () => {
    const mcpService = makeMcpService();
    const baseUrl = await mountMcpRoutes({ mcpService });
    const res = await send(baseUrl, { body: INITIALIZE });
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBeNull();
    expect((await messagesOf(res))[0].result.serverInfo.name).toBe('stub');
    // The messages reach the service, so it can tell an initialize apart.
    expect(mcpService.createRequestServer).toHaveBeenCalledWith(
      { userId: 'user-A', tokenId: null, bearer: '' },
      INITIALIZE,
    );
  });

  it('serves a request that was never preceded by an initialize', async () => {
    const baseUrl = await mountMcpRoutes({ mcpService: makeMcpService() });
    const res = await send(baseUrl, { body: TOOLS_LIST });
    expect(res.status).toBe(200);
    expect((await messagesOf(res))[0].result.tools).toEqual([{ name: 'for-user-A', inputSchema: { type: 'object' } }]);
  });

  it('ignores a stale session id instead of answering "Session not found"', async () => {
    const baseUrl = await mountMcpRoutes({ mcpService: makeMcpService() });
    const res = await send(baseUrl, { sessionId: 'sess-from-before-the-restart', body: TOOLS_LIST });
    expect(res.status).toBe(200);
    const [message] = await messagesOf(res);
    expect(message.error).toBeUndefined();
    expect(message.result.tools[0].name).toBe('for-user-A');
  });

  it('builds a server per request from that request\'s caller, and closes each one after its response', async () => {
    const mcpService = makeMcpService();
    const baseUrl = await mountMcpRoutes({ mcpService });
    const resA = await send(baseUrl, { body: TOOLS_LIST });
    const resB = await send(baseUrl, { body: TOOLS_LIST, user: 'user-B' });
    const resA2 = await send(baseUrl, { body: TOOLS_LIST });

    expect((await messagesOf(resA))[0].result.tools[0].name).toBe('for-user-A');
    expect((await messagesOf(resB))[0].result.tools[0].name).toBe('for-user-B');
    expect((await messagesOf(resA2))[0].result.tools[0].name).toBe('for-user-A');

    expect(mcpService.servers.map((s) => s.caller.userId)).toEqual(['user-A', 'user-B', 'user-A']);
    await waitFor(() => {
      for (const s of mcpService.servers) expect(s.close).toHaveBeenCalled();
    });
  });

  /**
   * The freshness property this endpoint gets for free, pinned so it cannot be
   * optimised away: because every request builds its own server off the live
   * registry, a manual committed between two requests is in the second one's
   * answer. No session to invalidate, no notification to honour, no reconnect
   * — the thing a stateful endpoint needs a whole refresh mechanism for.
   *
   * The `.tool` → registry half is `catalog-cache-invalidation.ts`'s (a commit
   * drops the caches at once); this is the half that says the endpoint then
   * SERVES what the registry holds, per request, forever.
   */
  it('serves a manual added between two requests, with no reconnect and no session', async () => {
    // The registry as the proxy sees it: whatever it holds when the server for
    // THIS request is built.
    const registry = ['read_file'];
    const mcpService = {
      createRequestServer: vi.fn(async () => {
        const snapshot = [...registry];
        const server = new Server({ name: 'stub', version: '0' }, { capabilities: { tools: {} } });
        server.setRequestHandler(ListToolsRequestSchema, async () => ({
          tools: snapshot.map((name) => ({ name, inputSchema: { type: 'object' as const } })),
        }));
        return server;
      }),
    };
    const baseUrl = await mountMcpRoutes({ mcpService });

    const before = await send(baseUrl, { body: TOOLS_LIST });
    expect((await messagesOf(before))[0].result.tools.map((t: { name: string }) => t.name)).toEqual(['read_file']);

    // A commit lands: a `.tool` is added, and another is removed.
    registry.push('serper_search');
    registry.splice(registry.indexOf('read_file'), 1);

    const after = await send(baseUrl, { body: TOOLS_LIST });
    expect((await messagesOf(after))[0].result.tools.map((t: { name: string }) => t.name)).toEqual(['serper_search']);
    // Same client, no `initialize` in between, no session id either way.
    expect(after.headers.get('mcp-session-id')).toBeNull();
  });

  it('answers a failure building the server with a JSON-RPC 500', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const baseUrl = await mountMcpRoutes({
      mcpService: {
        createRequestServer: async () => {
          throw new Error('Bevel tool discovery failed: loopback down');
        },
      },
    });
    const res = await send(baseUrl, { body: TOOLS_LIST });
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({
      jsonrpc: '2.0',
      error: { code: -32603, message: 'Bevel tool discovery failed: loopback down' },
      id: null,
    });
  });
});

describe.each(['GET', 'DELETE'])('%s /mcp (retired)', (method) => {
  it('answers 405 with Allow: POST and never builds a server', async () => {
    const mcpService = makeMcpService();
    const baseUrl = await mountMcpRoutes({ mcpService });
    const res = await send(baseUrl, { method, sessionId: 'any-session' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
    await expect(res.json()).resolves.toEqual({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed.' },
      id: null,
    });
    expect(mcpService.createRequestServer).not.toHaveBeenCalled();
  });
});
