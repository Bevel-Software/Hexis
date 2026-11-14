import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import '@utcp/http';
import { CallTemplateSerializer } from '@utcp/sdk';
import { CodeModeUtcpClient, type CodeModeUtcpClient as Client } from '@utcp/code-mode';
import { registerManual } from '../dispatch.js';
import { NO_BODY_FIELD, installGetHasNoBody, withoutBodyOnGet } from '../get-has-no-body.js';

/**
 * The rule a test has to pin, because a GET with a body is answered by a
 * service's edge rather than by the service: no tool whose HTTP method is GET
 * sends a request body, whatever arguments it is called with.
 *
 * Over a real HTTP round-trip, through a real UTCP client, with a tool
 * declared the way an administrator's inline manual declares one — the path
 * that has no platform code in it at all.
 */

interface Seen {
  method: string;
  body: string;
  query: Record<string, string>;
  hadContentLength: boolean;
}

let server: Server | undefined;
let client: Client | undefined;

afterEach(async () => {
  await client?.close().catch(() => {});
  client = undefined;
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
});

/**
 * A server that serves a UTCP manual, and records how its tools are called.
 * The manual's tools are filled in by the caller once the port is known — a
 * tool's `url` points back at this very server.
 */
async function serve(): Promise<{ base: string; seen: Seen[]; tools: Record<string, unknown>[] }> {
  const seen: Seen[] = [];
  const tools: Record<string, unknown>[] = [];
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (url.pathname === '/manual') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ utcp_version: '1.1.0', manual_version: '1.0.0', tools }));
        return;
      }
      seen.push({
        method: req.method ?? '',
        body,
        query: Object.fromEntries(url.searchParams.entries()),
        hadContentLength: req.headers['content-length'] !== undefined,
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  const port = await new Promise<number>((r) => server!.listen(0, () => r((server!.address() as { port: number }).port)));
  return { base: `http://127.0.0.1:${port}`, seen, tools };
}

describe('a GET tool sends no request body', () => {
  it('sends none even when called with an argument named `body` its schema allows', async () => {
    const { base, seen, tools } = await serve();
    tools.push({
      name: 'search',
      description: 'Search the other service.',
      // The schema ALLOWS `body`, so the argument check has nothing to say —
      // the guard, not the check, is what keeps the body off the request.
      inputs: {
        type: 'object',
        properties: { query: { type: 'string' }, body: { type: 'object' } },
        required: ['query'],
      },
      outputs: { type: 'object', properties: {} },
      tags: [],
      tool_call_template: {
        call_template_type: 'http',
        http_method: 'GET',
        url: `${base}/search`,
        content_type: 'application/json',
      },
    });
    client = await CodeModeUtcpClient.create(process.cwd(), { variables: {} } as never);
    const manual = new CallTemplateSerializer().validateDict({
      name: 'NS',
      call_template_type: 'http',
      http_method: 'GET',
      url: `${base}/manual`,
      content_type: 'application/json',
    });
    expect(await registerManual(client, manual)).toEqual({ ok: true });

    // Both ways a tool is called: the plain call, and the streaming one the
    // MCP dispatch (`dispatchToolCall`) really uses.
    await client.callTool('NS.search', { query: 'hello', body: { wrapped: 'arguments' } });
    // Drained: the request is what is under test, not the answer.
    const chunks: unknown[] = [];
    for await (const chunk of client.callToolStreaming('NS.search', { query: 'hello', body: { wrapped: 'arguments' } })) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(1);

    expect(seen).toHaveLength(2);
    for (const request of seen) {
      expect(request.method).toBe('GET');
      expect(request.body).toBe('');
      expect(request.hadContentLength).toBe(false);
      // Not dropped — the argument travels as a query parameter, like every
      // other argument of a GET tool.
      expect(request.query.query).toBe('hello');
      expect(JSON.stringify(request.query)).toMatch(/body/);
      expect(JSON.stringify(request.query)).toMatch(/arguments/);
    }
  });
});

describe('withoutBodyOnGet', () => {
  it('names a body field no tool declares, for a GET template', () => {
    expect(withoutBodyOnGet({ http_method: 'get', body_field: 'body', url: 'u' })).toEqual({
      http_method: 'get',
      body_field: NO_BODY_FIELD,
      url: 'u',
    });
  });

  it('leaves a POST template, an `mcp` template and a plain object alone', () => {
    const post = { http_method: 'POST', body_field: 'body' };
    expect(withoutBodyOnGet(post)).toBe(post);
    const mcp = { call_template_type: 'mcp' };
    expect(withoutBodyOnGet(mcp)).toBe(mcp);
    expect(withoutBodyOnGet(undefined)).toBeUndefined();
  });

  it('names a field no manual can write into its own template ahead of time', () => {
    // The documented prefix alone is not the name: a per-process tail follows
    // it, so a template carrying the bare prefix is rewritten like any other.
    expect(NO_BODY_FIELD).toMatch(/^__utcp_get_sends_no_body_[0-9a-f]{32}__$/);
    expect(withoutBodyOnGet({ http_method: 'GET', body_field: '__utcp_get_sends_no_body__' })).toEqual({
      http_method: 'GET',
      body_field: NO_BODY_FIELD,
    });
  });

  it('is idempotent', () => {
    const once = withoutBodyOnGet({ http_method: 'GET' });
    expect(withoutBodyOnGet(once)).toBe(once);
  });

  it('can be installed twice over the process registry', () => {
    expect(() => {
      installGetHasNoBody();
      installGetHasNoBody();
    }).not.toThrow();
  });
});
