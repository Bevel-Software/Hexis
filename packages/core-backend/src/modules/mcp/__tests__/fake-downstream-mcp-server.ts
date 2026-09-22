import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';

/**
 * A SESSION-FUL third-party MCP server over real HTTP — the kind an `mcp.json`
 * manual points at — for driving the proxy's downstream pool.
 *
 * Real, not stubbed, for the same reason as mcp-core's recovery fixture: the
 * pool's healing rests on a live server's session-loss shape (404 / `-32001`)
 * travelling intact through the SDK transport and `@utcp/mcp`.
 *
 * Not collected by vitest: the include pattern is `**\/*.test.ts`.
 */
export interface FakeDownstreamMcpServer {
  url: string;
  /** Forget every session, as a restart does. The process stays up. */
  restart(): Promise<void>;
  /** Stop listening and drop every connection. */
  stop(): Promise<void>;
  /** `initialize` requests served — one per downstream connection that reached the server. */
  initializations(): number;
  /** Times `echo` actually executed. */
  executions(): number;
  /** Sessions currently live on the server. */
  liveSessions(): number;
  /** Requests answered 401 because `acceptsToken` refused their bearer. */
  rejections(): number;
}

export interface FakeDownstreamOptions {
  /**
   * When set, every request must carry `Authorization: Bearer <token>` with a
   * token this accepts; anything else is answered 401 with an RFC 6750
   * `invalid_token` challenge — what an OAuth-protected MCP server answers a
   * revoked or expired token with.
   */
  acceptsToken?: (token: string) => boolean;
}

export async function startFakeDownstreamMcpServer(opts: FakeDownstreamOptions = {}): Promise<FakeDownstreamMcpServer> {
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  let initializations = 0;
  let executions = 0;
  let rejections = 0;

  function buildServer(): Server {
    const server = new Server({ name: 'downstream', version: '0.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'echo',
          description: 'Return the text it was given.',
          inputSchema: { type: 'object' as const, properties: { text: { type: 'string' } } },
        },
      ],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
      executions += 1;
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
      if (opts.acceptsToken) {
        const token = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
        if (!opts.acceptsToken(token)) {
          rejections += 1;
          res.writeHead(401, {
            'Content-Type': 'application/json',
            'WWW-Authenticate': 'Bearer error="invalid_token", error_description="The access token is invalid"',
          });
          res.end(JSON.stringify({ error: 'invalid_token', error_description: 'The access token is invalid' }));
          return;
        }
      }
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      const body = req.method === 'POST' ? await readBody(req) : undefined;
      const live = sessionId ? sessions.get(sessionId) : undefined;
      if (live) {
        await live.handleRequest(req, res, body);
        return;
      }
      if (req.method === 'POST' && isInitializeRequest(body)) {
        initializations += 1;
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id: string) => {
            sessions.set(id, transport);
          },
        });
        await buildServer().connect(transport);
        await transport.handleRequest(req, res, body);
        return;
      }
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
    await Promise.all(live.map((t) => t.close().catch(() => {})));
  }

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    restart: dropSessions,
    async stop() {
      await dropSessions();
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
    initializations: () => initializations,
    executions: () => executions,
    liveSessions: () => sessions.size,
    rejections: () => rejections,
  };
}
