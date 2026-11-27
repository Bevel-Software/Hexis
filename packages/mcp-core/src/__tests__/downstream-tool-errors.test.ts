import { afterEach, describe, expect, it } from 'vitest';
import '@utcp/mcp'; // side effect: registers the stock 'mcp' protocol, which the install wraps
import { McpCommunicationProtocol } from '@utcp/mcp';
import { CodeModeUtcpClient } from '@utcp/code-mode';
import { CallTemplateSerializer, CommunicationProtocol, type CallTemplate } from '@utcp/sdk';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { DownstreamToolError, installDownstreamToolErrors } from '../downstream-tool-errors.js';
import { registerManual, dispatchToolCall } from '../dispatch.js';
import type { ProxiedTool } from '../proxied-tool.js';
import { startFakeMcpServer, type FakeMcpServer } from './fake-mcp-server.js';

const serializer = new CallTemplateSerializer();
const stockFactory = CommunicationProtocol.communicationProtocolFactories['mcp'];

function manualTemplate(name: string, url: string): CallTemplate {
  return serializer.validateDict({
    name,
    call_template_type: 'mcp',
    config: { mcpServers: { srv: { transport: 'http', url, timeout: 10, terminate_on_close: true } } },
  });
}

const echo: ProxiedTool = {
  utcpName: 'notion.srv.echo',
  mcpName: 'notion_srv_echo',
  description: 'the echo tool',
  inputSchema: { type: 'object', properties: {} },
  manualName: 'notion',
};

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  // Every cleanup runs even when one fails, and a failure fails the test:
  // a server left running would otherwise leak into the next one unseen.
  const failures: unknown[] = [];
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch((err: unknown) => failures.push(err));
  CommunicationProtocol.communicationProtocolFactories['mcp'] = stockFactory;
  if (failures.length > 0) throw new AggregateError(failures, 'test cleanup failed');
});

/** A client built now, with the factory registered at this moment, connected to `server`. */
async function clientFor(server: FakeMcpServer): Promise<CodeModeUtcpClient> {
  const client = await CodeModeUtcpClient.create(process.cwd(), null);
  cleanups.push(() => client.close());
  expect(await registerManual(client, manualTemplate('notion', server.url))).toEqual({ ok: true });
  return client;
}

async function startServer(): Promise<FakeMcpServer> {
  const server = await startFakeMcpServer('notion');
  cleanups.push(() => server.stop());
  return server;
}

/** Failure answers a server can give, in the shapes `@utcp/mcp`'s unwrap treats differently. */
const failures: Record<string, CallToolResult> = {
  'one text block': { isError: true, content: [{ type: 'text', text: 'This tool requires a Business plan or higher.' }] },
  'text that is JSON': { isError: true, content: [{ type: 'text', text: '{"code":"E42","message":"no calendar is connected"}' }] },
  'several blocks': {
    isError: true,
    content: [
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' },
    ],
  },
  'structured content beside its text': {
    isError: true,
    content: [{ type: 'text', text: 'only in the content' }],
    structuredContent: { code: 'E42' },
  },
  'no content': { isError: true, content: [] },
  'an image and no text': { isError: true, content: [{ type: 'image', data: 'aGk=', mimeType: 'image/png' }] },
};

describe('the unwrap installDownstreamToolErrors wraps', () => {
  it('finds the unwrap it wraps in the installed @utcp/mcp (fails when a release renames it)', () => {
    const protocol = new McpCommunicationProtocol() as unknown as { _processMcpToolResult?: unknown };
    expect(typeof protocol._processMcpToolResult).toBe('function');
  });
});

describe('a downstream isError over a real MCP connection', () => {
  it.each(Object.entries(failures))(
    'answers %s as it did when the failure passed for a success, and only adds the flag',
    async (_shape, failure) => {
      const server = await startServer();
      server.reportToolErrors(failure);
      // Built before the install: the bug, a failure read as a success.
      const before = await dispatchToolCall(await clientFor(server), echo, { text: 'hi' });
      installDownstreamToolErrors();
      const after = await dispatchToolCall(await clientFor(server), echo, { text: 'hi' });

      expect(before.isError).toBeUndefined();
      expect(after).toEqual({ ...before, isError: true });
    },
  );

  it("is a failed call in the server's own words, run once", async () => {
    installDownstreamToolErrors();
    const server = await startServer();
    const client = await clientFor(server);
    server.reportToolErrors('This tool requires a Business plan or higher.');

    const result = await dispatchToolCall(client, echo, { text: 'hi' });

    expect(result).toEqual({ isError: true, content: [{ type: 'text', text: 'This tool requires a Business plan or higher.' }] });
    // A reported failure is an answer, not a reason to retry.
    expect(server.executions('echo')).toBe(1);
  });

  it('rejects the call a chain makes, with the text of the answer as the message', async () => {
    installDownstreamToolErrors();
    const server = await startServer();
    const client = await clientFor(server);

    server.reportToolErrors('This tool requires a Business plan or higher.');
    await expect(client.callTool('notion.srv.echo', { text: 'hi' })).rejects.toThrow(DownstreamToolError);
    await expect(client.callTool('notion.srv.echo', { text: 'hi' })).rejects.toThrow('This tool requires a Business plan or higher.');

    // An answer with no text at all still rejects with words a person can read.
    server.reportToolErrors({ isError: true, content: [{ type: 'image', data: 'aGk=', mimeType: 'image/png' }] });
    await expect(client.callTool('notion.srv.echo', { text: 'hi' })).rejects.toThrow(/failed and gave no details/);
  });

  it('leaves a successful call untouched once installed', async () => {
    installDownstreamToolErrors();
    const server = await startServer();
    const client = await clientFor(server);

    const result = await dispatchToolCall(client, echo, { text: 'hi' });

    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify({ echoed: 'hi' }) }]);
  });
});

describe('installDownstreamToolErrors', () => {
  it('wraps the factory that is registered, once, and a client still gets an instance of its own', () => {
    let built = 0;
    const registered = () => {
      built += 1;
      return new McpCommunicationProtocol();
    };
    CommunicationProtocol.communicationProtocolFactories['mcp'] = registered;

    installDownstreamToolErrors();
    const installed = CommunicationProtocol.communicationProtocolFactories['mcp']!;
    installDownstreamToolErrors();

    expect(CommunicationProtocol.communicationProtocolFactories['mcp']).toBe(installed);
    expect(installed()).not.toBe(installed());
    expect(built).toBe(2);
  });
});
