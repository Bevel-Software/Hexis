import { afterEach, describe, expect, it, vi } from 'vitest';
import '@utcp/mcp'; // side effect: registers the 'mcp' UTCP communication protocol
import { CodeModeUtcpClient } from '@utcp/code-mode';
import { CallTemplateSerializer, type CallTemplate } from '@utcp/sdk';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  installSessionRecovery,
  isSessionLoss,
  noteManualReregistered,
} from '../session-recovery.js';
import { registerManual, dispatchToolCall } from '../dispatch.js';
import { dispatchMetaTool } from '../meta-tools.js';
import type { ProxiedTool } from '../proxied-tool.js';
import { startFakeMcpServer, type FakeMcpServer } from './fake-mcp-server.js';

const serializer = new CallTemplateSerializer();

/** The manual a surface registers a remote MCP server as. */
function manualTemplate(name: string, url: string): CallTemplate {
  return serializer.validateDict({
    name,
    call_template_type: 'mcp',
    config: {
      mcpServers: {
        srv: { transport: 'http', url, timeout: 10, terminate_on_close: true },
      },
    },
  });
}

function proxiedTool(manual: string, tool: string): ProxiedTool {
  return {
    utcpName: `${manual}.srv.${tool}`,
    mcpName: tool,
    description: `the ${tool} tool`,
    inputSchema: { type: 'object', properties: {} },
    manualName: manual,
  };
}

/** Everything a test needs torn down, in reverse order of creation. */
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => {});
  vi.restoreAllMocks();
});

async function startServer(name = 'fake'): Promise<FakeMcpServer> {
  const server = await startFakeMcpServer(name);
  cleanups.push(() => server.stop());
  return server;
}

/**
 * A client wired the way a surface wires it: manuals registered, then session
 * recovery installed over the same templates. `log` is captured rather than
 * printed so a test can assert on the one line a recovery is allowed to emit.
 */
async function connectedClient(
  manuals: Record<string, string>,
): Promise<{ client: CodeModeUtcpClient; log: string[]; reregistrations: string[] }> {
  const templates = new Map(
    Object.entries(manuals).map(([name, url]) => [name, manualTemplate(name, url)] as const),
  );
  const client = await CodeModeUtcpClient.create(process.cwd(), null);
  cleanups.push(() => client.close());
  for (const template of templates.values()) {
    const result = await registerManual(client, template);
    expect(result).toEqual({ ok: true });
  }
  const log: string[] = [];
  const reregistrations: string[] = [];
  installSessionRecovery(client, {
    manualTemplate: (name) => templates.get(name),
    afterReregister: (name) => {
      reregistrations.push(name);
    },
    log: (message) => log.push(message),
  });
  return { client, log, reregistrations };
}

/** Call a tool the way the MCP dispatch surface does. */
async function callOverMcpSurface(
  client: CodeModeUtcpClient,
  manual: string,
  tool: string,
  args: Record<string, unknown> = {},
): Promise<string> {
  const result = await dispatchToolCall(client, proxiedTool(manual, tool), args);
  const text = (result.content[0] as { text: string } | undefined)?.text ?? '';
  if (result.isError) throw new Error(text);
  return text;
}

describe('isSessionLoss', () => {
  it('matches the live shape: a 404 whose body is the JSON-RPC session miss', () => {
    // Verbatim what the SDK transport throws for the platform's own 404 —
    // the status lives on `code`, the JSON-RPC code only in the message.
    const err = new StreamableHTTPError(
      404,
      'Error POSTing to endpoint: {"jsonrpc":"2.0","error":{"code":-32001,"message":"Session not found"},"id":null}',
    );
    expect(isSessionLoss(err)).toBe(true);
  });

  it('matches a 404 that carries only the reserved message', () => {
    expect(isSessionLoss(new StreamableHTTPError(404, 'Session not found'))).toBe(true);
  });

  it('follows a cause chain to reach the transport error', () => {
    const wrapped = new Error('MCP operation on \'srv\' failed', {
      cause: new StreamableHTTPError(404, 'Error POSTing to endpoint: {"error":{"code":-32001}}'),
    });
    expect(isSessionLoss(wrapped)).toBe(true);
  });

  it('does NOT match a request timeout, whose JSON-RPC code is also -32001', () => {
    // The trap this classifier exists to avoid: `ErrorCode.RequestTimeout` is
    // -32001 too. Retrying a timeout could execute a mutating tool twice.
    expect(isSessionLoss(new McpError(ErrorCode.RequestTimeout, 'Request timed out'))).toBe(false);
    expect(isSessionLoss(new Error("MCP operation on 'srv' timed out after 60s."))).toBe(false);
  });

  it('does NOT match an auth failure, a tool error, or a refused connection', () => {
    expect(isSessionLoss(new StreamableHTTPError(401, 'Error POSTing to endpoint: Unauthorized'))).toBe(false);
    expect(isSessionLoss(new McpError(ErrorCode.InvalidParams, 'Missing required argument "path"'))).toBe(false);
    expect(isSessionLoss(new McpError(ErrorCode.ConnectionClosed, 'Connection closed'))).toBe(false);
    expect(isSessionLoss(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), { code: 'ECONNREFUSED' }))).toBe(false);
  });

  it('does NOT match a 404 that is an ordinary not-found', () => {
    expect(isSessionLoss(new StreamableHTTPError(404, 'Error POSTing to endpoint: Not Found'))).toBe(false);
  });
});

describe('session recovery', () => {
  it('heals the next call after the platform restarts, telling the caller nothing but a log line', async () => {
    const platform = await startServer('platform');
    const { client, log, reregistrations } = await connectedClient({ platform: platform.url });

    expect(await callOverMcpSurface(client, 'platform', 'echo', { text: 'before' })).toContain('before');

    await platform.restart();

    expect(await callOverMcpSurface(client, 'platform', 'echo', { text: 'after' })).toContain('after');
    expect(reregistrations).toEqual(['platform']);
    expect(log).toEqual([`[mcp] session lost on 'platform' — re-registered and retried.`]);
    // The retry is what executed; the lost-session attempt never reached the tool.
    expect(platform.executions('echo')).toBe(2);
  }, 20_000);

  it('heals a proxied third-party server independently of the platform manual', async () => {
    const platform = await startServer('platform');
    const thirdParty = await startServer('third-party');
    const { client, reregistrations } = await connectedClient({
      platform: platform.url,
      weather: thirdParty.url,
    });

    await thirdParty.restart();

    expect(await callOverMcpSurface(client, 'weather', 'echo', { text: 'sunny' })).toContain('sunny');
    expect(reregistrations).toEqual(['weather']);
    // The platform manual never lost its session, so it was never re-registered.
    expect(platform.initializations()).toBe(1);
    expect(thirdParty.initializations()).toBe(2);
  }, 20_000);

  it('never retries a genuine tool error — a mutating tool executes exactly once', async () => {
    const platform = await startServer('platform');
    const { client, log, reregistrations } = await connectedClient({ platform: platform.url });

    platform.failToolCalls('the provider returned 500');

    await expect(callOverMcpSurface(client, 'platform', 'bump')).rejects.toThrow(/provider returned 500/);
    // The guarantee that makes recovery safe: nothing outside the session-loss
    // class is retried, so a mutating tool is never executed a second time.
    expect(platform.executions('bump')).toBe(1);
    expect(reregistrations).toEqual([]);
    expect(platform.initializations()).toBe(1);
    expect(log).toEqual([]);
  }, 20_000);

  it('never retries an auth failure or a refused connection', async () => {
    const platform = await startServer('platform');
    const { client, log, reregistrations } = await connectedClient({ platform: platform.url });

    platform.failWithAuthError(true);
    await expect(callOverMcpSurface(client, 'platform', 'echo')).rejects.toThrow();
    expect(reregistrations).toEqual([]);
    platform.failWithAuthError(false);

    await platform.stop();
    await expect(callOverMcpSurface(client, 'platform', 'echo')).rejects.toThrow();
    expect(reregistrations).toEqual([]);
    expect(log).toEqual([]);
  }, 20_000);

  it('coalesces concurrent session losses on one manual into a single re-registration', async () => {
    const platform = await startServer('platform');
    const { client, reregistrations } = await connectedClient({ platform: platform.url });

    await callOverMcpSurface(client, 'platform', 'echo', { text: 'warm' });
    await platform.restart();

    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((n) => callOverMcpSurface(client, 'platform', 'echo', { text: `call-${n}` })),
    );

    expect(results.map((r) => JSON.parse(r).echoed).sort()).toEqual([
      'call-1',
      'call-2',
      'call-3',
      'call-4',
      'call-5',
    ]);
    expect(reregistrations).toEqual(['platform']);
    // One initialize for the original session, one for the recovery. Five
    // would be the stampede this test exists to forbid.
    expect(platform.initializations()).toBe(2);
  }, 20_000);

  it('recovers a tool call made from inside a code-mode chain', async () => {
    const platform = await startServer('platform');
    const { client, reregistrations } = await connectedClient({ platform: platform.url });

    await platform.restart();

    // `call_tool_chain` reaches tools through `callTool`, not the streaming
    // dispatch path — the same wrapper has to cover both.
    const result = await dispatchMetaTool(client, 'call_tool_chain', {
      code: `return platform.srv_echo({ text: 'from-chain' });`,
    });
    expect(result.isError).toBeFalsy();
    expect((result.content[0] as { text: string }).text).toContain('from-chain');
    expect(reregistrations).toEqual(['platform']);
  }, 30_000);

  it('surfaces a failing retry to the caller, and does not recover a second time', async () => {
    const platform = await startServer('platform');
    const { client, reregistrations } = await connectedClient({ platform: platform.url });

    await platform.restart();
    // Re-registration (a tools/list) still succeeds; the retried CALL does not.
    platform.failToolCalls('the tool is broken');

    await expect(callOverMcpSurface(client, 'platform', 'echo')).rejects.toThrow(/the tool is broken/);
    expect(reregistrations).toEqual(['platform']);
    expect(platform.initializations()).toBe(2);
    // Only the retry ever reached the tool.
    expect(platform.executions('echo')).toBe(1);
  }, 20_000);

  it('surfaces the original failure when the manual is not one this surface holds', async () => {
    const platform = await startServer('platform');
    const client = await CodeModeUtcpClient.create(process.cwd(), null);
    cleanups.push(() => client.close());
    expect(await registerManual(client, manualTemplate('platform', platform.url))).toEqual({ ok: true });
    const log: string[] = [];
    installSessionRecovery(client, { manualTemplate: () => undefined, log: (m) => log.push(m) });

    await platform.restart();

    await expect(callOverMcpSurface(client, 'platform', 'echo')).rejects.toThrow();
    expect(platform.initializations()).toBe(1);
    expect(log).toEqual([]);
  }, 20_000);
});

describe('session recovery — invariants that only a stubbed client can force', () => {
  /** A client that fails the first N calls with `err`, then succeeds. */
  function stubClient(overrides: Partial<Record<string, unknown>>): CodeModeUtcpClient {
    return {
      registerManual: async () => ({ success: true }),
      deregisterManual: async () => true,
      ...overrides,
    } as unknown as CodeModeUtcpClient;
  }

  const sessionLost = (): StreamableHTTPError =>
    new StreamableHTTPError(404, 'Error POSTing to endpoint: {"jsonrpc":"2.0","error":{"code":-32001,"message":"Session not found"},"id":null}');

  it('does not replay a stream that already produced output', async () => {
    let starts = 0;
    const client = stubClient({
      async *callToolStreaming() {
        starts += 1;
        yield 'first chunk';
        throw sessionLost();
      },
      async callTool() {
        throw new Error('unused');
      },
    });
    installSessionRecovery(client, {
      manualTemplate: () => manualTemplate('platform', 'http://127.0.0.1:1/mcp'),
      log: () => {},
    });

    const seen: unknown[] = [];
    await expect(
      (async () => {
        for await (const chunk of client.callToolStreaming('platform.srv.echo', {})) seen.push(chunk);
      })(),
    ).rejects.toThrow(/Session not found/);
    // A session miss is decided before the first byte, so a stream that has
    // already emitted cannot be one — replaying it would duplicate chunks.
    expect(seen).toEqual(['first chunk']);
    expect(starts).toBe(1);
  });

  it('installs once however many times it is asked, so a retry never stacks', async () => {
    let calls = 0;
    let registrations = 0;
    const client = stubClient({
      registerManual: async () => {
        registrations += 1;
        return { success: true };
      },
      async callTool() {
        calls += 1;
        throw sessionLost();
      },
      // Present only so the wrapper has something to bind; this test drives
      // the `callTool` path the code-mode chain uses.
      callToolStreaming: () => {
        throw new Error('not exercised by this test');
      },
    });
    const options = {
      manualTemplate: () => manualTemplate('platform', 'http://127.0.0.1:1/mcp'),
      log: () => {},
    };
    installSessionRecovery(client, options);
    installSessionRecovery(client, options);

    await expect(client.callTool('platform.srv.echo', {})).rejects.toThrow(/Session not found/);
    // One attempt plus exactly one retry — a second wrapper would have made
    // it four, and re-registered twice.
    expect(calls).toBe(2);
    expect(registrations).toBe(1);
  });

  /** A stub whose `callTool` loses the session once, then answers 'ok'. */
  function losesSessionOnce(): { client: CodeModeUtcpClient; calls: () => number } {
    let calls = 0;
    const client = stubClient({
      async callTool() {
        calls += 1;
        if (calls === 1) throw sessionLost();
        return 'ok';
      },
      callToolStreaming: () => {
        throw new Error('not exercised by this test');
      },
    });
    return { client, calls: () => calls };
  }

  it('surfaces the original session loss when the template resolver throws', async () => {
    const { client, calls } = losesSessionOnce();
    const log: string[] = [];
    installSessionRecovery(client, {
      manualTemplate: () => {
        throw new Error('config store unreachable');
      },
      log: (m) => log.push(m),
    });

    // The caller's error is the one the CALL produced. A resolver blowing up
    // means recovery did not happen — not that the failure changes shape.
    await expect(client.callTool('platform.srv.echo', {})).rejects.toThrow(/Session not found/);
    expect(calls()).toBe(1);
    expect(log).toEqual([
      `[mcp] session lost on 'platform' — not recovered (re-registration threw: config store unreachable); the original failure stands.`,
    ]);
  });

  it('surfaces the original session loss when the surface gate throws', async () => {
    const { client, calls } = losesSessionOnce();
    installSessionRecovery(client, {
      manualTemplate: () => manualTemplate('platform', 'http://127.0.0.1:1/mcp'),
      withReregister: () => Promise.reject(new Error('shutting down')),
      log: () => {},
    });

    await expect(client.callTool('platform.srv.echo', {})).rejects.toThrow(/Session not found/);
    expect(calls()).toBe(1);
  });

  it('runs the whole re-registration inside the surface gate, once', async () => {
    const { client } = losesSessionOnce();
    const order: string[] = [];
    installSessionRecovery(client, {
      manualTemplate: () => {
        order.push('template');
        return manualTemplate('platform', 'http://127.0.0.1:1/mcp');
      },
      afterReregister: () => {
        order.push('cleanup');
      },
      withReregister: async (name, run) => {
        order.push(`gate:enter:${name}`);
        try {
          return await run();
        } finally {
          order.push('gate:exit');
        }
      },
      log: () => {},
    });

    expect(await client.callTool('platform.srv.echo', {})).toBe('ok');
    // Nothing the surface has to serialize against — template resolution, the
    // deregister/register pair, the cleanup — may escape the gate.
    expect(order).toEqual(['gate:enter:platform', 'template', 'cleanup', 'gate:exit']);
  });

  it('reuses a session the surface re-registered while the recovery waited at its gate', async () => {
    const { client, calls } = losesSessionOnce();
    let registrations = 0;
    let deregistrations = 0;
    Object.assign(client, {
      registerManual: async () => {
        registrations += 1;
        return { success: true };
      },
      deregisterManual: async () => {
        deregistrations += 1;
        return true;
      },
    });
    const log: string[] = [];
    installSessionRecovery(client, {
      manualTemplate: () => manualTemplate('platform', 'http://127.0.0.1:1/mcp'),
      // The surface's own re-registration — hexis-mcp's credential swap —
      // completing while this recovery is queued behind it for the gate.
      withReregister: async (_name, run) => {
        noteManualReregistered(client, 'platform');
        return run();
      },
      log: (m) => log.push(m),
    });

    expect(await client.callTool('platform.srv.echo', {})).toBe('ok');
    // The swap's session is live and postdates the failure, so recovery must
    // retry against it rather than tear it down to dial an identical third.
    expect(registrations).toBe(0);
    expect(deregistrations).toBe(0);
    expect(calls()).toBe(2);
    expect(log).toEqual([
      `[mcp] session lost on 'platform' — re-registered by a concurrent call; retrying.`,
    ]);
  });

  it('ignores a re-registration reported for a client that has no recovery installed', () => {
    // The surface calls this unconditionally; a client without recovery (a
    // test double, an embedding host that never installed it) is not an error.
    expect(() => noteManualReregistered(stubClient({}), 'platform')).not.toThrow();
  });

  it('keeps one recovered call to one log line however much went sideways', async () => {
    let calls = 0;
    const client = stubClient({
      deregisterManual: async () => {
        throw new Error('manual already gone');
      },
      async callTool() {
        calls += 1;
        if (calls === 1) throw sessionLost();
        return 'ok';
      },
      callToolStreaming: () => {
        throw new Error('not exercised by this test');
      },
    });
    const log: string[] = [];
    installSessionRecovery(client, {
      manualTemplate: () => manualTemplate('platform', 'http://127.0.0.1:1/mcp'),
      afterReregister: () => {
        throw new Error('purge failed');
      },
      log: (m) => log.push(m),
    });

    expect(await client.callTool('platform.srv.echo', {})).toBe('ok');
    // One recovery is one event: the abnormalities ride in that line rather
    // than arriving as lines of their own, which would read as three
    // recoveries to anyone watching stderr.
    expect(log).toEqual([
      `[mcp] session lost on 'platform' — re-registered and retried. ` +
        `(deregistering first failed: manual already gone; post-re-registration cleanup failed: purge failed)`,
    ]);
  });
});
