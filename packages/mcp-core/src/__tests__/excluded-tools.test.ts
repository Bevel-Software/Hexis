import { afterEach, describe, expect, it } from 'vitest';
import '@utcp/mcp'; // side effect: registers the 'mcp' UTCP communication protocol
import { CodeModeUtcpClient } from '@utcp/code-mode';
import { CallTemplateSerializer, type CallTemplate } from '@utcp/sdk';
import { EXCLUDE_TOOLS_KEY, excludedTools } from '../excluded-tools.js';
import { registerManual, dispatchToolCall } from '../dispatch.js';
import { installSessionRecovery } from '../session-recovery.js';
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

describe('excludedTools', () => {
  it('names each left-out tool by its server entry and the name that server lists it under', () => {
    const template = manualTemplate('my-notion', 'http://127.0.0.1:1/mcp', ['bump', 'other']);
    expect(excludedTools(template)).toEqual([
      ['srv', 'bump'],
      ['srv', 'other'],
    ]);
  });

  it('survives the template check and a JSON round trip, as it travels to every surface', () => {
    const template = manualTemplate('notion', 'http://127.0.0.1:1/mcp', ['bump']);
    const travelled = serializer.validateDict(JSON.parse(JSON.stringify(template)) as Record<string, unknown>);
    expect(excludedTools(travelled)).toEqual([['srv', 'bump']]);
  });

  it('is empty for a manual that leaves nothing out, or is not an MCP server', () => {
    expect(excludedTools(manualTemplate('notion', 'http://127.0.0.1:1/mcp'))).toEqual([]);
    const http = { name: 'web', call_template_type: 'http', url: 'https://x.test/m', http_method: 'GET' };
    expect(excludedTools(http as unknown as CallTemplate)).toEqual([]);
  });

  it('is null for a list of the wrong shape, and reads a server entry that is no object as leaving nothing out', () => {
    const entries = (srv: unknown) =>
      ({ name: 'n', call_template_type: 'mcp', config: { mcpServers: { srv, two: null } } }) as unknown as CallTemplate;
    expect(excludedTools(entries({ [EXCLUDE_TOOLS_KEY]: 'bump' }))).toBeNull();
    expect(excludedTools(entries({ [EXCLUDE_TOOLS_KEY]: ['bump', 7] }))).toBeNull();
    expect(excludedTools(entries({ [EXCLUDE_TOOLS_KEY]: [''] }))).toBeNull();
    expect(excludedTools(entries({}))).toEqual([]);
  });
});

describe('registerManual over a real MCP connection', () => {
  it('takes a left-out tool off the client, keeps its siblings, and the client still connects', async () => {
    const server = await startFakeMcpServer('notion');
    cleanups.push(() => server.stop());
    const client = await CodeModeUtcpClient.create(process.cwd(), null);
    cleanups.push(() => client.close());
    // The key rides in the server entry; the MCP client must still accept it.
    // A name UTCP rewrites when it registers (`my-notion` to `my_notion`), as
    // an mcp.json server's usually is: the left-out tool is named the same way.
    expect(await registerManual(client, manualTemplate('my-notion', server.url, ['bump']))).toEqual({ ok: true });

    expect((await client.getTools()).map((t) => t.name)).toEqual(['my_notion.srv.echo']);
  });

  it.each(['my notion.v2', 'notion (team/eu)', 'nötion'])(
    'takes it off under whatever name UTCP registers the manual by: %s',
    async (name) => {
      const server = await startFakeMcpServer('notion');
      cleanups.push(() => server.stop());
      const client = await CodeModeUtcpClient.create(process.cwd(), null);
      cleanups.push(() => client.close());

      expect(await registerManual(client, manualTemplate(name, server.url, ['bump']))).toEqual({ ok: true });

      // The name is UTCP's, read after the registration: whatever it made of
      // `name`, exactly one tool is left and it is not the left-out one.
      const left = (await client.getTools()).map((t) => t.name);
      expect(left).toHaveLength(1);
      expect(left[0]).toMatch(/\.srv\.echo$/);
    },
  );

  it('leaves no manual registered when a left-out tool cannot be taken off, rather than one with every tool', async () => {
    const server = await startFakeMcpServer('notion');
    cleanups.push(() => server.stop());
    const client = await CodeModeUtcpClient.create(process.cwd(), null);
    cleanups.push(() => client.close());
    // A repository that refuses the removal (the in-memory one never does).
    client.config.tool_repository.removeTool = async () => {
      throw new Error('the repository refused the removal');
    };

    const result = await registerManual(client, manualTemplate('notion', server.url, ['bump']));

    expect(result).toEqual({ ok: false, error: 'the repository refused the removal' });
    expect(await client.getTools()).toEqual([]);
    expect(await client.config.tool_repository.getManual('notion')).toBeUndefined();
  });

  it('registers a manual that leaves out a name the server does not list, and keeps every tool it does list', async () => {
    const server = await startFakeMcpServer('notion');
    cleanups.push(() => server.stop());
    const client = await CodeModeUtcpClient.create(process.cwd(), null);
    cleanups.push(() => client.close());

    expect(await registerManual(client, manualTemplate('notion', server.url, ['no-such-tool']))).toEqual({ ok: true });

    expect((await client.getTools()).map((t) => t.name).sort()).toEqual(['notion.srv.bump', 'notion.srv.echo']);
  });

  it('keeps it off when the manual registers again, as a session recovery or a refresh does', async () => {
    const server = await startFakeMcpServer('notion');
    cleanups.push(() => server.stop());
    const client = await CodeModeUtcpClient.create(process.cwd(), null);
    cleanups.push(() => client.close());
    expect(await registerManual(client, manualTemplate('notion', server.url, ['bump']))).toEqual({ ok: true });

    await client.deregisterManual('notion');
    expect(await registerManual(client, manualTemplate('notion', server.url, ['bump']))).toEqual({ ok: true });

    expect((await client.getTools()).map((t) => t.name)).toEqual(['notion.srv.echo']);
  });

  it('keeps it off through a real session recovery: the server forgets the session, the call heals, the tool stays gone', async () => {
    const server = await startFakeMcpServer('notion');
    cleanups.push(() => server.stop());
    const client = await CodeModeUtcpClient.create(process.cwd(), null);
    cleanups.push(() => client.close());
    const template = manualTemplate('notion', server.url, ['bump']);
    expect(await registerManual(client, template)).toEqual({ ok: true });
    const reregistered: string[] = [];
    installSessionRecovery(client, {
      manualTemplate: (name) => (name === 'notion' ? template : undefined),
      afterReregister: (name) => {
        reregistered.push(name);
      },
      log: () => {},
    });

    await server.restart();
    const echo = { utcpName: 'notion.srv.echo', mcpName: 'echo', description: 'echo', inputSchema: { type: 'object' as const, properties: {} }, manualName: 'notion' };
    const result = await dispatchToolCall(client, echo, { text: 'after' });

    expect(result.isError).toBeUndefined();
    expect(reregistered).toEqual(['notion']);
    expect((await client.getTools()).map((t) => t.name)).toEqual(['notion.srv.echo']);
  }, 20_000);

  it('registers nothing for a list of the wrong shape, rather than every tool it was written to leave out', async () => {
    const server = await startFakeMcpServer('notion');
    cleanups.push(() => server.stop());
    const client = await CodeModeUtcpClient.create(process.cwd(), null);
    cleanups.push(() => client.close());
    const template = manualTemplate('notion', server.url);
    const entry = (template as unknown as { config: { mcpServers: { srv: Record<string, unknown> } } }).config.mcpServers.srv;
    entry[EXCLUDE_TOOLS_KEY] = 'bump';

    const result = await registerManual(client, template);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(EXCLUDE_TOOLS_KEY);
    expect(await client.getTools()).toEqual([]);
  });
});
