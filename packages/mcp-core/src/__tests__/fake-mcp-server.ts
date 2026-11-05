import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';

/**
 * A scriptable MCP server over real HTTP, used to drive session recovery
 * against the failure shape a live server actually produces.
 *
 * The point of using a real server rather than a stubbed client: the whole
 * safety argument for retrying rests on ONE error shape — HTTP 404 carrying
 * JSON-RPC `-32001` — travelling intact from the wire, through the MCP SDK's
 * transport, through `@utcp/mcp`, to our classifier. A hand-built `Error` would
 * assert our belief about that shape instead of the shape itself, and the
 * belief is the part most likely to be wrong (or to drift on a version bump).
 *
 * Session routing mirrors the platform's own (`mcp.routes.ts`): a live session
 * id is forwarded, an `initialize` always starts a fresh session whatever stale
 * id it carries, a session id we hold nothing for is the 404, and no session id
 * at all is the 400.
 */
export interface FakeMcpServer {
  url: string;
  /** Throw away every session, as a restart does. The process stays up. */
  restart(): Promise<void>;
  /** Stop listening entirely — the "server is DOWN" case. */
  stop(): Promise<void>;
  /** `initialize` requests served; one per registration that reached the server. */
  initializations(): number;
  /** How many times each tool actually EXECUTED (the double-execution guard). */
  executions(toolName: string): number;
  /**
   * Make every tool call fail from now on the way a genuinely broken tool does:
   * the handler throws, the SDK turns that into a JSON-RPC error response, and
   * the client rejects with an `McpError`. Nothing about it is session-shaped.
   */
  failToolCalls(reason: string | null): void;
  /** Answer every request 401, as a server that has stopped accepting our key. */
  failWithAuthError(on: boolean): void;
}

const TOOLS = [
  {
    name: 'echo',
    description: 'Return the text it was given.',
    inputSchema: { type: 'object' as const, properties: { text: { type: 'string' } } },
  },
  {
    name: 'bump',
    description: 'A MUTATING tool: increments a counter and returns its new value.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
];

export async function startFakeMcpServer(name = 'fake'): Promise<FakeMcpServer> {
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: Server }>();
  const executions = new Map<string, number>();
  let initializations = 0;
  let counter = 0;
  let toolFailure: string | null = null;
  let authFailure = false;

  function buildServer(): Server {
    const server = new Server({ name, version: '0.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
    server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
      const tool = request.params.name;
      executions.set(tool, (executions.get(tool) ?? 0) + 1);
      // Thrown, not returned as `isError`: a handler that throws is what
      // reaches the caller as an exception, which is the only failure shape
      // recovery could ever mistake for session loss.
      if (toolFailure) throw new Error(toolFailure);
      if (tool === 'bump') {
        counter += 1;
        return { content: [{ type: 'text', text: JSON.stringify({ counter }) }] };
      }
      const text = String((request.params.arguments as { text?: unknown } | undefined)?.text ?? '');
      return { content: [{ type: 'text', text: JSON.stringify({ echoed: text }) }] };
    });
    return server;
  }

  function jsonRpcError(res: ServerResponse, status: number, code: number, message: string): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
  }

  async function readBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    if (chunks.length === 0) return undefined;
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return undefined;
    }
  }

  const http: HttpServer = createServer((req, res) => {
    void (async () => {
      if (authFailure) {
        jsonRpcError(res, 401, -32000, 'Unauthorized');
        return;
      }
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      const body = req.method === 'POST' ? await readBody(req) : undefined;
      const live = sessionId ? sessions.get(sessionId) : undefined;
      if (live) {
        await live.transport.handleRequest(req, res, body);
        return;
      }
      if (req.method === 'POST' && isInitializeRequest(body)) {
        initializations += 1;
        const server = buildServer();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id: string): void => {
            sessions.set(id, { transport, server });
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) sessions.delete(transport.sessionId);
        };
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
        return;
      }
      // The signal this whole feature keys on: a session id we hold nothing
      // for. Anything without an id at all is the caller's own mistake.
      if (sessionId) {
        jsonRpcError(res, 404, -32001, 'Session not found');
        return;
      }
      jsonRpcError(res, 400, -32000, 'Bad Request: Mcp-Session-Id header is required');
    })().catch(() => {
      if (!res.headersSent) jsonRpcError(res, 500, -32603, 'Internal error');
      else res.end();
    });
  });

  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address() as AddressInfo;

  async function dropSessions(): Promise<void> {
    const live = [...sessions.values()];
    sessions.clear();
    // Closing after clearing: the transport's onclose would otherwise delete
    // an entry a re-initialize may already have put back.
    await Promise.all(live.map((s) => s.transport.close().catch(() => {})));
  }

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    restart: dropSessions,
    async stop() {
      await dropSessions();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      // A keep-alive socket the client still holds would let a request hang
      // past close(); drop them so a call against a stopped server refuses.
      http.closeAllConnections?.();
    },
    initializations: () => initializations,
    executions: (toolName: string) => executions.get(toolName) ?? 0,
    failToolCalls: (reason: string | null) => {
      toolFailure = reason;
    },
    failWithAuthError: (on: boolean) => {
      authFailure = on;
    },
  };
}
