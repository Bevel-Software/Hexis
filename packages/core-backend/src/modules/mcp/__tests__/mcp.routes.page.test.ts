import { afterEach, describe, expect, it, vi } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { McpCaller } from '../mcp.service.js';
import { closeMountedRoutes, mountMcpRoutes } from './mcp-routes-harness.js';

/**
 * The page a call comes from: an HTML page of the knowledge base whose script
 * calls the viewer's tools through the app. The app names it in
 * `X-Bevel-Page`, and only the app — a session — may: a key, an OAuth token or
 * an internal token belongs to an agent with an Audit log row of its own.
 */

afterEach(async () => {
  await closeMountedRoutes();
  vi.restoreAllMocks();
});

function makeMcpService() {
  const callers: McpCaller[] = [];
  return {
    callers,
    createRequestServer: vi.fn(async (caller: McpCaller) => {
      callers.push(caller);
      const server = new Server({ name: 'stub', version: '0' }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
      return server;
    }),
    recordPageRefusal: vi.fn(async () => {}),
  };
}

const TOOLS_LIST = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
const PAGE = 'Dashboards/Road map — Q4.html';

function post(baseUrl: string, path: string, body: unknown, headers: Record<string, string>) {
  return fetch(`${baseUrl}/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  });
}

describe('POST /mcp with X-Bevel-Page', () => {
  it("hands a session's page to the service, decoded", async () => {
    const mcpService = makeMcpService();
    const baseUrl = await mountMcpRoutes({ mcpService });
    const res = await post(baseUrl, '/mcp', TOOLS_LIST, { 'x-test-kind': 'session', 'x-bevel-page': encodeURIComponent(PAGE) });
    expect(res.status).toBe(200);
    expect(mcpService.callers[0]).toMatchObject({ userId: 'user-A', page: PAGE });
  });

  it.each(['key', 'oauth', 'internal'])('refuses the header from a %s caller, building nothing', async (kind) => {
    const mcpService = makeMcpService();
    const baseUrl = await mountMcpRoutes({ mcpService });
    const res = await post(baseUrl, '/mcp', TOOLS_LIST, { 'x-test-kind': kind, 'x-bevel-page': encodeURIComponent(PAGE) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain('X-Bevel-Page');
    expect(mcpService.createRequestServer).not.toHaveBeenCalled();
  });

  it('refuses a page that is not a path', async () => {
    const mcpService = makeMcpService();
    const baseUrl = await mountMcpRoutes({ mcpService });
    const res = await post(baseUrl, '/mcp', TOOLS_LIST, { 'x-test-kind': 'session', 'x-bevel-page': encodeURIComponent('a\nb') });
    expect(res.status).toBe(400);
  });

  it('names no page when the header is absent, as before', async () => {
    const mcpService = makeMcpService();
    const baseUrl = await mountMcpRoutes({ mcpService });
    await post(baseUrl, '/mcp', TOOLS_LIST, { 'x-test-kind': 'session' });
    expect(mcpService.callers[0]).not.toHaveProperty('page');
  });
});

describe('POST /mcp/page-refusals', () => {
  it("records a session's refused call under its page", async () => {
    const mcpService = makeMcpService();
    const baseUrl = await mountMcpRoutes({ mcpService });
    const res = await post(
      baseUrl,
      '/mcp/page-refusals',
      { page: PAGE, tool: 'edit_file', args: { body: { path: 'a.md' } } },
      { 'x-test-kind': 'session', Authorization: 'Bearer eyJ.session' },
    );
    expect(res.status).toBe(204);
    expect(mcpService.recordPageRefusal).toHaveBeenCalledWith(
      { userId: 'user-A', bearer: 'eyJ.session' },
      PAGE,
      'edit_file',
      { body: { path: 'a.md' } },
    );
  });

  it('is the app\'s alone: an agent credential is refused', async () => {
    const mcpService = makeMcpService();
    const baseUrl = await mountMcpRoutes({ mcpService });
    const res = await post(baseUrl, '/mcp/page-refusals', { page: PAGE, tool: 'edit_file' }, { 'x-test-kind': 'key' });
    expect(res.status).toBe(403);
    expect(mcpService.recordPageRefusal).not.toHaveBeenCalled();
  });

  it('wants a page and a tool', async () => {
    const mcpService = makeMcpService();
    const baseUrl = await mountMcpRoutes({ mcpService });
    const res = await post(baseUrl, '/mcp/page-refusals', { tool: 'edit_file' }, { 'x-test-kind': 'session' });
    expect(res.status).toBe(400);
    for (const tool of [undefined, '']) {
      const noTool = await post(baseUrl, '/mcp/page-refusals', { page: PAGE, tool }, { 'x-test-kind': 'session' });
      expect(noTool.status).toBe(400);
    }
    expect(mcpService.recordPageRefusal).not.toHaveBeenCalled();
  });
});
