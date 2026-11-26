import { afterEach, describe, expect, it } from 'vitest';
import '@utcp/mcp'; // side effect: registers the 'mcp' UTCP communication protocol
import { CodeModeUtcpClient } from '@utcp/code-mode';
import { CallTemplateSerializer, type CallTemplate } from '@utcp/sdk';
import { EXCLUDE_TOOLS_KEY, excludedToolNames, removeExcludedTools } from '../excluded-tools.js';
import { registerManual } from '../dispatch.js';
import { startFakeMcpServer } from './fake-mcp-server.js';

const serializer = new CallTemplateSerializer();

/** A manual as the platform builds it from an `mcp.json` server whose `plugin.json` leaves `exclude` out. */
function manualTemplate(name: string, url: string, exclude?: string[]): CallTemplate {
  return serializer.validateDict({
    name,
    call_template_type: 'mcp',
    config: {
      mcpServers: {
        srv: { transport: 'http', url, timeout: 10, ...(exclude ? { [EXCLUDE_TOOLS_KEY]: exclude } : {}) },
      },
    },
  });
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  // Every cleanup runs even when one fails, and a failure fails the test:
  // a server left running would otherwise leak into the next one unseen.
  const failures: unknown[] = [];
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch((err: unknown) => failures.push(err));
  if (failures.length > 0) throw new AggregateError(failures, 'test cleanup failed');
});

describe('excludedToolNames', () => {
  it('names each left-out tool as UTCP registers it, the manual name rewritten', () => {
    const template = manualTemplate('my-notion', 'http://127.0.0.1:1/mcp', ['bump', 'other']);
    expect(excludedToolNames(template)).toEqual(['my_notion.srv.bump', 'my_notion.srv.other']);
  });

  it('survives the template check and a JSON round trip, as it travels to every surface', () => {
    const template = manualTemplate('notion', 'http://127.0.0.1:1/mcp', ['bump']);
    const travelled = serializer.validateDict(JSON.parse(JSON.stringify(template)) as Record<string, unknown>);
    expect(excludedToolNames(travelled)).toEqual(['notion.srv.bump']);
  });

  it('is empty for a manual that leaves nothing out, or is not an MCP server', () => {
    expect(excludedToolNames(manualTemplate('notion', 'http://127.0.0.1:1/mcp'))).toEqual([]);
    const http = { name: 'web', call_template_type: 'http', url: 'https://x.test/m', http_method: 'GET' };
    expect(excludedToolNames(http as unknown as CallTemplate)).toEqual([]);
  });

  it('ignores a malformed entry rather than throwing', () => {
    const odd = { name: 'n', call_template_type: 'mcp', config: { mcpServers: { srv: { [EXCLUDE_TOOLS_KEY]: 'bump' }, two: null } } };
    expect(excludedToolNames(odd as unknown as CallTemplate)).toEqual([]);
  });
});

describe('removeExcludedTools over a real MCP connection', () => {
  it('takes a left-out tool off the client, keeps its siblings, and the client still connects', async () => {
    const server = await startFakeMcpServer('notion');
    cleanups.push(() => server.stop());
    const client = await CodeModeUtcpClient.create(process.cwd(), null);
    cleanups.push(() => client.close());
    const template = manualTemplate('notion', server.url, ['bump']);
    const excluded = new Set(excludedToolNames(template));
    // The key rides in the server entry; the MCP client must still accept it.
    expect(await registerManual(client, template)).toEqual({ ok: true });

    const kept = await removeExcludedTools(client, await client.getTools(), excluded);

    expect(kept.map((t) => t.name)).toEqual(['notion.srv.echo']);
    expect((await client.getTools()).map((t) => t.name)).toEqual(['notion.srv.echo']);
  });
});
