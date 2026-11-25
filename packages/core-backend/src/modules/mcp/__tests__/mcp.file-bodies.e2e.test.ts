import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type RequestHandler } from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createMcpRoutes } from '../mcp.routes.js';
import { McpService } from '../mcp.service.js';
import { FileBodyError } from '../../code-mode/index.js';
import { SpillStore } from '../../workspace/index.js';
import { createManualRoutes, ToolRegistry } from '../../tool-registry/index.js';

/**
 * A tool that sends a file, over the real MCP transport: a call to an `http`
 * tool whose body is declared a file path goes out with the bytes of the file
 * it names, read as the caller, a direct call and a call from a chain alike.
 * The argument check still sees the call as the agent made it, and a file the
 * caller cannot read refuses the call before anything is sent. A tool that
 * declares a form sends the file as one part of it, beside the other parts.
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

/** The files the caller may read, by the path a call names. */
const FILES: Record<string, string> = {
  'Reports/q3.pdf': '%PDF-1.7 the third quarter',
  'Reports/Müller 报告 "final".docx': 'a memo',
};

/** A reader over {@link FILES} that remembers each read, as `user:ref`. */
function filesReader(reads: string[]) {
  return async (userId: string, ref: string): Promise<Uint8Array> => {
    reads.push(`${userId}:${ref}`);
    const text = FILES[ref];
    if (text === undefined) throw new FileBodyError(`"${ref}" is not a file you can read, so it cannot be sent`);
    return Buffer.from(text);
  };
}

interface Platform {
  baseUrl: string;
  /** The bytes each upload received, as text. */
  uploads: string[];
  /** Each form the other service received, as it parsed it. */
  forms: ReceivedForm[];
  stop(): Promise<void>;
}

/** One form as the receiving service read it off the wire: its declared type, and each part in order. */
interface ReceivedForm {
  contentType: string;
  parts: Array<{ name: string; text: string; filename?: string; type?: string }>;
}

const platforms: Platform[] = [];
const cleanups: Array<() => Promise<void>> = [];

/** The deployment's own tool, an `http` manual whose `upload` body is declared a file path. */
const THIRD_PARTY_MANUAL = {
  name: 'THIRD_PARTY',
  call_template_type: 'http',
  http_method: 'GET',
  url: '${API_URL}/api/third-party/manual',
  content_type: 'application/json',
};

async function startPlatform(readFileBody?: (userId: string, ref: string) => Promise<Uint8Array>): Promise<Platform> {
  const uploads: string[] = [];
  const forms: ReceivedForm[] = [];
  const app = express();
  // The form is parsed by the platform's own multipart reader (`Response.formData`), from the bytes and the
  // Content-Type the call arrived with, so a missing boundary or a malformed part fails here.
  app.post('/api/third-party/boards/:board/documents', express.raw({ type: 'multipart/form-data' }), async (req, res) => {
    const contentType = req.headers['content-type'] ?? '';
    const form = await new Response(req.body as Buffer, { headers: { 'content-type': contentType } }).formData();
    const parts: ReceivedForm['parts'] = [];
    for (const [name, value] of form.entries()) {
      parts.push(typeof value === 'string' ? { name, text: value } : { name, text: await value.text(), filename: value.name, type: value.type });
    }
    forms.push({ contentType, parts });
    res.json({ stored: true, board: req.params.board });
  });
  app.post('/api/third-party/upload', express.raw({ type: 'application/octet-stream' }), (req, res) => {
    uploads.push(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : JSON.stringify(req.body));
    res.json({ stored: true });
  });
  app.use(express.json());
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
        {
          name: 'add_document',
          description: 'Put a file on a board in the other service.',
          inputs: {
            type: 'object',
            properties: {
              board: { type: 'string', description: 'The board.' },
              body: {
                type: 'object',
                properties: {
                  resource: { type: 'string', format: 'file-path', description: 'The file to send.' },
                  data: { type: 'object', description: 'Where it goes.' },
                },
                required: ['resource'],
                additionalProperties: false,
              },
            },
            required: ['board', 'body'],
            additionalProperties: false,
          },
          outputs: { type: 'object', properties: {} },
          tags: [],
          tool_call_template: {
            call_template_type: 'http',
            http_method: 'POST',
            url: `\${API_URL}/api/third-party/boards/{board}/documents`,
            content_type: 'multipart/form-data',
          },
        },
      ],
    }),
  );
  app.get('/api/agent/all-tools', (_req, res) => {
    res.json({ manuals: [THIRD_PARTY_MANUAL] });
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
    ...(readFileBody ? { readFileBody } : {}),
  });
  const stub = {} as never;
  app.use('/api', createMcpRoutes(service, stub, fakeAuth, fakeAuth, stub, stub, stub, ''));
  app.use('/api', createManualRoutes(new ToolRegistry(), passthrough));

  let stopped = false;
  const platform: Platform = {
    baseUrl,
    uploads,
    forms,
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
  const client = new Client({ name: 'file-bodies-e2e', version: '0.0.0' }, { capabilities: {} });
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

describe('a tool that sends a file, called through the MCP endpoint', () => {
  it('sends the bytes of the file a direct call names, read as the caller', async () => {
    const reads: string[] = [];
    const platform = await startPlatform(filesReader(reads));
    const client = await connect(platform.baseUrl);
    const res = await client.callTool({ name: 'THIRD_PARTY_upload', arguments: { body: 'Reports/q3.pdf' } });
    expect(res.isError).toBeFalsy();
    expect(reads).toEqual(['user-A:Reports/q3.pdf']);
    expect(platform.uploads).toEqual(['%PDF-1.7 the third quarter']);
  });

  it('does the same for a call from a chain', async () => {
    const platform = await startPlatform(filesReader([]));
    const client = await connect(platform.baseUrl);
    const res = await client.callTool({ name: 'call_tool_chain', arguments: { code: "return THIRD_PARTY.upload({ body: 'Reports/q3.pdf' });" } });
    expect(JSON.parse(toolText(res)).result).toEqual({ stored: true });
    expect(platform.uploads).toEqual(['%PDF-1.7 the third quarter']);
  });

  it('refuses a call for a file the caller cannot read, with the reason, and sends nothing', async () => {
    const platform = await startPlatform(filesReader([]));
    const client = await connect(platform.baseUrl);
    const res = await client.callTool({ name: 'THIRD_PARTY_upload', arguments: { body: 'Finance/Payroll.xlsx' } });
    expect(res.isError).toBe(true);
    expect(toolText(res)).toContain('"Finance/Payroll.xlsx" is not a file you can read, so it cannot be sent');
    expect(platform.uploads).toEqual([]);
  });

  it('checks the arguments first: a call that does not match its tool is refused before any file is read', async () => {
    const reads: string[] = [];
    const platform = await startPlatform(filesReader(reads));
    const client = await connect(platform.baseUrl);
    const res = await client.callTool({ name: 'THIRD_PARTY_upload', arguments: { body: 'Reports/q3.pdf', extra: 1 } });
    expect(res.isError).toBe(true);
    expect(toolText(res)).toContain('The arguments do not match the "upload" tool.');
    expect(reads).toEqual([]);
    expect(platform.uploads).toEqual([]);
  });

  it('sends a form: the file as its own part with its name and type, the JSON part beside it, from a direct call and a chain', async () => {
    const reads: string[] = [];
    const platform = await startPlatform(filesReader(reads));
    const client = await connect(platform.baseUrl);
    const body = { resource: 'Reports/q3.pdf', data: { title: 'Q3', position: { x: 0, y: 0 } } };
    const res = await client.callTool({ name: 'THIRD_PARTY_add_document', arguments: { board: 'b1', body } });
    expect(res.isError).toBeFalsy();
    const chained = await client.callTool({
      name: 'call_tool_chain',
      arguments: { code: `return THIRD_PARTY.add_document({ board: 'b2', body: ${JSON.stringify(body)} });` },
    });
    expect(JSON.parse(toolText(chained)).result).toEqual({ stored: true, board: 'b2' });
    expect(reads).toEqual(['user-A:Reports/q3.pdf', 'user-A:Reports/q3.pdf']);
    expect(platform.forms).toHaveLength(2);
    for (const form of platform.forms) {
      expect(form.contentType).toMatch(/^multipart\/form-data; boundary=/);
      expect(form.parts).toEqual([
        { name: 'resource', text: '%PDF-1.7 the third quarter', filename: 'q3.pdf', type: 'application/pdf' },
        { name: 'data', text: '{"title":"Q3","position":{"x":0,"y":0}}' },
      ]);
    }
  });

  it('carries a file name with spaces, quotes and letters outside ASCII to the other service as it is', async () => {
    const platform = await startPlatform(filesReader([]));
    const client = await connect(platform.baseUrl);
    const res = await client.callTool({ name: 'THIRD_PARTY_add_document', arguments: { board: 'b1', body: { resource: 'Reports/Müller 报告 "final".docx' } } });
    expect(res.isError).toBeFalsy();
    expect(platform.forms.map((f) => f.parts)).toEqual([
      [
        {
          name: 'resource',
          text: 'a memo',
          filename: 'Müller 报告 "final".docx',
          type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        },
      ],
    ]);
  });

  it('refuses a form whose file the caller cannot read, and sends nothing', async () => {
    const platform = await startPlatform(filesReader([]));
    const client = await connect(platform.baseUrl);
    const res = await client.callTool({ name: 'THIRD_PARTY_add_document', arguments: { board: 'b1', body: { resource: 'Finance/Payroll.xlsx' } } });
    expect(res.isError).toBe(true);
    expect(toolText(res)).toContain('"Finance/Payroll.xlsx" is not a file you can read, so it cannot be sent');
    expect(platform.forms).toEqual([]);
  });

  it('refuses a form whose file part is blank, though the arguments match the tool, and sends nothing', async () => {
    const reads: string[] = [];
    const platform = await startPlatform(filesReader(reads));
    const client = await connect(platform.baseUrl);
    const res = await client.callTool({ name: 'THIRD_PARTY_add_document', arguments: { board: 'b1', body: { resource: '  ', data: { title: 'Q3' } } } });
    expect(res.isError).toBe(true);
    expect(toolText(res)).toContain('The form\'s "resource" part takes the path of one file to send, and the call gave it none.');
    expect(reads).toEqual([]);
    expect(platform.forms).toEqual([]);
  });

  it('without a reader, sends the path as the agent wrote it', async () => {
    const platform = await startPlatform();
    const client = await connect(platform.baseUrl);
    await client.callTool({ name: 'THIRD_PARTY_upload', arguments: { body: 'Reports/q3.pdf' } });
    expect(platform.uploads).toEqual(['Reports/q3.pdf']);
  });
});
