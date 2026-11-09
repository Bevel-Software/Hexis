import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type RequestHandler } from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createMcpRoutes } from '../mcp.routes.js';
import { McpService, type McpClientHook } from '../mcp.service.js';
import { SpillStore } from '../../workspace/spill-store.js';
import { createManualRoutes } from '../../tool-registry/manual.routes.js';
import { ToolRegistry } from '../../tool-registry/tool-registry.js';

/**
 * `prepareClient`, over the real MCP transport: the deployment's hook runs on
 * the tool client built for each caller, with the caller's user id, and every
 * call that caller makes goes through what it installed, a direct call and a
 * call from a chain alike. The hook here does what a distribution's does with
 * a body its tool declares a file path: the bytes of the file it names go out
 * in its place. The argument check still sees the call as the agent made it.
 */

const KEY = 'bevel_key_user_a';
const bearerOf = (req: express.Request) => (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');

const fakeAuth: RequestHandler = (req, res, next) => {
  if (bearerOf(req) !== KEY) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  req.userId = 'user-A';
  req.externalApiKeyId = 'tok-A';
  next();
};

const passthrough: RequestHandler = (_req, _res, next) => next();

/** The files a hook may read, by the path a call names. */
const FILES: Record<string, string> = { 'Reports/q3.pdf': '%PDF-1.7 the third quarter' };

/** A hook that sends the named file's bytes as the body, and remembers whom each client was built for. */
function fileBodyHook(builtFor: string[]): McpClientHook {
  return (client, userId) => {
    builtFor.push(userId);
    const withBytes = (args: Record<string, unknown>) =>
      typeof args.body === 'string' && FILES[args.body] ? { ...args, body: Buffer.from(FILES[args.body]) } : args;
    // A direct call streams, a chain's does not: both are wrapped, as a distribution wraps them.
    const callTool = client.callTool.bind(client);
    client.callTool = async (toolName, args) => callTool(toolName, withBytes(args));
    const callToolStreaming = client.callToolStreaming.bind(client);
    client.callToolStreaming = async function* (toolName, args) {
      yield* callToolStreaming(toolName, withBytes(args));
    };
  };
}

interface Platform {
  baseUrl: string;
  /** The bytes each upload received, as text. */
  uploads: string[];
  stop(): Promise<void>;
}

const platforms: Platform[] = [];
const cleanups: Array<() => Promise<void>> = [];

async function startPlatform(prepareClient?: McpClientHook): Promise<Platform> {
  const uploads: string[] = [];
  const app = express();
  app.post('/api/third-party/upload', express.raw({ type: 'application/octet-stream' }), (req, res) => {
    uploads.push(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : JSON.stringify(req.body));
    res.json({ stored: true });
  });
  app.use(express.json());
  // A deployment's tool that sends a file: its body is declared a file path.
  app.get('/api/third-party/manual', (_req, res) =>
    res.json({
      utcp_version: '1.1.0',
      manual_version: '1.0.0',
      tools: [
        {
          name: 'upload',
          description: 'Store a file in the other service.',
          inputs: {
            type: 'object',
            properties: { body: { type: 'string', format: 'file-path', description: 'The file to send.' } },
            required: ['body'],
            additionalProperties: false,
          },
          outputs: { type: 'object', properties: {} },
          tags: [],
          tool_call_template: {
            call_template_type: 'http',
            http_method: 'POST',
            url: `\${API_URL}/api/third-party/upload`,
            content_type: 'application/octet-stream',
          },
        },
      ],
    }),
  );
  app.get('/api/agent/all-tools', (_req, res) => {
    res.json({
      manuals: [
        {
          name: 'THIRD_PARTY',
          call_template_type: 'http',
          http_method: 'GET',
          url: '${API_URL}/api/third-party/manual',
          content_type: 'application/json',
        },
      ],
    });
  });

  const httpServer = await new Promise<HttpServer>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = httpServer.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  const service = new McpService({
    loopbackBaseUrl: baseUrl,
    manualName: 'KNOWLEDGE_BASE',
    spillStore: new SpillStore(join(tmpdir(), 'bevel-test-spills')),
    publicFrontendUrl: 'http://localhost:5173',
    ...(prepareClient ? { prepareClient } : {}),
  });
  const stub = {} as never;
  app.use('/api', createMcpRoutes(service, stub, fakeAuth, fakeAuth, stub, stub, stub, ''));
  app.use('/api', createManualRoutes(new ToolRegistry(), passthrough));

  let stopped = false;
  const platform: Platform = {
    baseUrl,
    uploads,
    async stop() {
      if (stopped) return;
      stopped = true;
      service.onSecretsChanged(null);
      httpServer.closeAllConnections();
      await new Promise<void>((r) => httpServer.close(() => r()));
    },
  };
  platforms.push(platform);
  return platform;
}

async function connect(baseUrl: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/api/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${KEY}` } },
  });
  const client = new Client({ name: 'prepare-client-e2e', version: '0.0.0' }, { capabilities: {} });
  await client.connect(transport);
  cleanups.push(async () => {
    await client.close();
  });
  return client;
}

const toolText = (res: { content?: unknown }) => (res.content as Array<{ text: string }>)[0].text;

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c().catch(() => {});
  for (const p of platforms.splice(0)) await p.stop().catch(() => {});
});

describe('prepareClient: the deployment wraps each caller\'s tool client', () => {
  it('runs on the client built for the caller, and a direct call goes out through what it installed', async () => {
    const builtFor: string[] = [];
    const platform = await startPlatform(fileBodyHook(builtFor));
    const client = await connect(platform.baseUrl);
    const res = await client.callTool({ name: 'THIRD_PARTY_upload', arguments: { body: 'Reports/q3.pdf' } });
    expect(res.isError).toBeFalsy();
    expect(builtFor).toEqual(['user-A']);
    expect(platform.uploads).toEqual(['%PDF-1.7 the third quarter']);
  });

  it('wraps a call from a chain the same way', async () => {
    const platform = await startPlatform(fileBodyHook([]));
    const client = await connect(platform.baseUrl);
    const res = await client.callTool({ name: 'call_tool_chain', arguments: { code: "return THIRD_PARTY.upload({ body: 'Reports/q3.pdf' });" } });
    expect(JSON.parse(toolText(res)).result).toEqual({ stored: true });
    expect(platform.uploads).toEqual(['%PDF-1.7 the third quarter']);
  });

  it('leaves the argument check outermost: a call that does not match its tool is refused before the hook sees it', async () => {
    const platform = await startPlatform(fileBodyHook([]));
    const client = await connect(platform.baseUrl);
    const res = await client.callTool({ name: 'THIRD_PARTY_upload', arguments: { body: 'Reports/q3.pdf', extra: 1 } });
    expect(res.isError).toBe(true);
    expect(toolText(res)).toContain('The arguments do not match the "upload" tool.');
    expect(platform.uploads).toEqual([]);
  });

  it('without a hook, sends the call as it was made', async () => {
    const platform = await startPlatform();
    const client = await connect(platform.baseUrl);
    await client.callTool({ name: 'THIRD_PARTY_upload', arguments: { body: 'Reports/q3.pdf' } });
    expect(platform.uploads).toEqual(['Reports/q3.pdf']);
  });
});
