import { afterEach, describe, expect, it } from 'vitest';
import '@utcp/mcp'; // side effect: registers the stock 'mcp' protocol, which the install replaces
import { McpCommunicationProtocol } from '@utcp/mcp';
import { CodeModeUtcpClient } from '@utcp/code-mode';
import { CallTemplateSerializer, CommunicationProtocol, type CallTemplate } from '@utcp/sdk';
import { downstreamErrorText, installDownstreamToolErrors } from '../downstream-tool-errors.js';
import { registerManual, dispatchToolCall } from '../dispatch.js';
import type { ProxiedTool } from '../proxied-tool.js';
import { startFakeMcpServer } from './fake-mcp-server.js';

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

async function clientFor(url: string): Promise<CodeModeUtcpClient> {
  const client = await CodeModeUtcpClient.create(process.cwd(), null);
  cleanups.push(() => client.close());
  expect(await registerManual(client, manualTemplate('notion', url))).toEqual({ ok: true });
  return client;
}

describe('downstreamErrorText', () => {
  it('reads the text of a result that reports its own failure', () => {
    expect(
      downstreamErrorText({ isError: true, content: [{ type: 'text', text: 'Requires a Business plan' }] }),
    ).toBe('Requires a Business plan');
  });

  it('is null for a result that does not report a failure', () => {
    expect(downstreamErrorText({ content: [{ type: 'text', text: '{"error":"looks like one"}' }] })).toBeNull();
    expect(downstreamErrorText({ isError: false, content: [] })).toBeNull();
    expect(downstreamErrorText('text')).toBeNull();
    expect(downstreamErrorText(null)).toBeNull();
  });

  it('still says it failed when the result carries no text', () => {
    expect(downstreamErrorText({ isError: true, content: [{ type: 'image', data: '', mimeType: 'image/png' }] })).toMatch(
      /failed/,
    );
  });
});

describe('the unwrap installDownstreamToolErrors wraps', () => {
  it('finds the unwrap it wraps in the installed @utcp/mcp (fails when a release renames it)', () => {
    const protocol = new McpCommunicationProtocol() as unknown as { _processMcpToolResult?: unknown };
    expect(typeof protocol._processMcpToolResult).toBe('function');
  });
});

describe('a downstream isError over a real MCP connection', () => {
  it('reached the caller as a success before the install (the bug)', async () => {
    const server = await startFakeMcpServer('notion');
    cleanups.push(() => server.stop());
    const client = await clientFor(server.url);
    server.reportToolErrors('This tool requires a Business plan or higher.');

    const result = await dispatchToolCall(client, echo, { text: 'hi' });

    expect(result.isError).toBeUndefined();
    expect(JSON.stringify(result.content)).toContain('Business plan');
  });

  it("reaches the caller as a failed call, in the server's own words, once installed", async () => {
    installDownstreamToolErrors();
    const server = await startFakeMcpServer('notion');
    cleanups.push(() => server.stop());
    const client = await clientFor(server.url);
    server.reportToolErrors('This tool requires a Business plan or higher.');

    const result = await dispatchToolCall(client, echo, { text: 'hi' });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: 'This tool requires a Business plan or higher.' }]);
    // The call ran once: a reported failure is an answer, not a reason to retry.
    expect(server.executions('echo')).toBe(1);
  });

  it('leaves a successful call untouched once installed', async () => {
    installDownstreamToolErrors();
    const server = await startFakeMcpServer('notion');
    cleanups.push(() => server.stop());
    const client = await clientFor(server.url);

    const result = await dispatchToolCall(client, echo, { text: 'hi' });

    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify({ echoed: 'hi' }) }]);
  });
});
