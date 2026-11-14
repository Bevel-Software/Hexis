import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { Tool } from '@utcp/sdk';
import type { CodeModeUtcpClient } from '@utcp/code-mode';
import { ArgumentsDoNotMatchError, argumentRefusal, installCallGuards } from '../call-guards.js';
import { checkFor } from '../tool-interface.js';
import { registerManual } from '../dispatch.js';
import { BODY_AT_TOP_LEVEL_LINE } from '../tool-interface.js';

/**
 * The guards in front of every call: the arguments checked against the tool's
 * schema on BOTH call paths (`callToolStreaming` is MCP dispatch,
 * `callTool` is what a chain bridges to), a matching call passed on unchanged,
 * and an answer that is a web page cut to something readable.
 */

function utcpTool(name: string, inputs: unknown, templateType = 'http'): Tool {
  return {
    name,
    description: `the ${name} tool`,
    inputs,
    outputs: { type: 'object', properties: {} },
    tags: [],
    tool_call_template: { call_template_type: templateType } as never,
  } as Tool;
}

const SEARCH = utcpTool('NS.search', {
  type: 'object',
  properties: { query: { type: 'string', description: 'The search text.' }, limit: { type: 'integer' } },
  required: ['query'],
  additionalProperties: false,
});

const READ_FILE = utcpTool('KB.read_file', {
  type: 'object',
  properties: {
    body: {
      type: 'object',
      properties: { branch: { type: 'string' }, path: { type: 'string' } },
      required: ['branch', 'path'],
      additionalProperties: false,
    },
  },
  required: ['body'],
  additionalProperties: false,
});

function guardedClient(tools: Tool[], answer: unknown = { ok: true }) {
  const callTool = vi.fn(async (...args: [string, Record<string, unknown>]) => {
    void args;
    return answer;
  });
  const callToolStreaming = vi.fn(async function* (...args: [string, Record<string, unknown>]) {
    void args;
    yield answer;
  });
  const client = {
    config: {
      tool_repository: {
        getTool: async (name: string) => tools.find((t) => t.name === name),
        getTools: async () => tools,
      },
    },
    callTool,
    callToolStreaming,
  } as unknown as CodeModeUtcpClient;
  installCallGuards(client);
  return { client, callTool, callToolStreaming };
}

async function drain(gen: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const chunk of gen) out.push(chunk);
  return out;
}

describe('installCallGuards — the argument check', () => {
  it('passes a matching call on with exactly the arguments that were given', async () => {
    const { client, callTool, callToolStreaming } = guardedClient([SEARCH]);
    const args = { query: 'x', limit: 3 };
    await client.callTool('NS.search', args);
    await drain(client.callToolStreaming('NS.search', args));
    expect(callTool).toHaveBeenCalledWith('NS.search', args);
    expect(callToolStreaming).toHaveBeenCalledWith('NS.search', args);
    // Not merely equal — the same arguments, nothing added, removed or renamed.
    expect(Object.keys((callTool.mock.calls[0] as unknown[])[1] as object)).toEqual(['query', 'limit']);
  });

  it('refuses a flat tool called with its arguments in a `body`, and sends nothing', async () => {
    const { client, callTool } = guardedClient([SEARCH]);
    await expect(client.callTool('NS.search', { body: { query: 'x' } })).rejects.toThrow(ArgumentsDoNotMatchError);
    expect(callTool).not.toHaveBeenCalled();
    const error = await client.callTool('NS.search', { body: { query: 'x' } }).catch((e) => e);
    expect(error.status).toBe(400);
    expect(error.kind).toBe('arguments-do-not-match');
    expect(error.response.data.kind).toBe('arguments-do-not-match');
    expect(error.message).toContain(BODY_AT_TOP_LEVEL_LINE);
    expect(error.message).toContain('"query" is required, and was not given.');
    expect(error.message).toContain('query (string, required) — The search text.');
    expect(error.message.split('\n').pop()).toBe('Call: NS.search({ query: "..." })');
  });

  it('refuses the same mismatch on the streaming path, before the stream opens', async () => {
    const { client, callToolStreaming } = guardedClient([SEARCH]);
    await expect(drain(client.callToolStreaming('NS.search', { body: { query: 'x' } }))).rejects.toThrow(
      /arguments do not match/,
    );
    expect(callToolStreaming).not.toHaveBeenCalled();
  });

  it('holds a tool that is not hosted here to its own `branch` like any other argument', async () => {
    // The platform's `branch-required` wording belongs to the platform's
    // routes, which the guard leaves alone (see below). A connected tool that
    // happens to declare a required `branch` gets its declaration enforced.
    const { client, callTool } = guardedClient([READ_FILE]);
    await expect(client.callTool('KB.read_file', { body: { path: 'a.md' } })).rejects.toThrow(
      /"body\.branch" is required, and was not given\./,
    );
    expect(callTool).not.toHaveBeenCalled();
  });

  it('calls a tool whose schema cannot be used for checking, and logs the reason once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Restored whatever happens below, so a failing assertion cannot leave
    // `console.warn` silenced for every test after this one.
    try {
      const odd = utcpTool('NS.odd_schema_for_log_test', { anyOf: [{ type: 'object' }, { type: 'string' }] });
      const { client, callTool } = guardedClient([odd]);
      await client.callTool(odd.name, { whatever: true });
      await client.callTool(odd.name, { whatever: true });
      expect(callTool).toHaveBeenCalledTimes(2);
      const mine = warn.mock.calls.filter((c) => String(c[0]).includes('odd_schema_for_log_test'));
      expect(mine).toHaveLength(1);
      expect(String(mine[0][0])).toContain('anyOf');
    } finally {
      warn.mockRestore();
    }
  });

  it('leaves a tool it has never heard of to the client\'s own not-found answer', async () => {
    const { client, callTool } = guardedClient([SEARCH]);
    await client.callTool('NS.absent', { anything: 1 });
    expect(callTool).toHaveBeenCalledWith('NS.absent', { anything: 1 });
  });

  it('stays outermost when another layer wraps the call methods after it', async () => {
    const { client, callTool } = guardedClient([SEARCH]);
    const inner = client.callTool.bind(client);
    const routed = vi.fn((name: string, args: Record<string, unknown>) => inner(name, args));
    client.callTool = routed as unknown as typeof client.callTool;
    installCallGuards(client);
    await expect(client.callTool('NS.search', {})).rejects.toThrow(/arguments do not match/);
    expect(routed).not.toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalled();
  });

  it('installs once when nothing has wrapped the methods since', () => {
    const { client } = guardedClient([SEARCH]);
    const before = client.callTool;
    installCallGuards(client);
    expect(client.callTool).toBe(before);
  });
});

describe('installCallGuards — an answer that is not JSON', () => {
  it('cuts a web page to a short error instead of handing over the markup', async () => {
    const page = `<!DOCTYPE html>\n<html><head><title>Forbidden</title></head><body>${'x'.repeat(5000)}END-OF-PAGE</body></html>`;
    const { client } = guardedClient([SEARCH], page);
    const error = await client.callTool('NS.search', { query: 'x' }).catch((e) => e);
    expect(error.message).toContain('answered with a page, not JSON');
    expect(error.message).toContain('Forbidden');
    // The first 200 characters of the page, and not a character more.
    expect(error.message).not.toContain('END-OF-PAGE');
    expect(error.message.length).toBeLessThan(300);
  });

  it('leaves an ordinary string answer alone', async () => {
    const { client } = guardedClient([SEARCH], 'plain text, no markup');
    await expect(client.callTool('NS.search', { query: 'x' })).resolves.toBe('plain text, no markup');
  });

  it('leaves a page from a tool that does not answer over HTTP alone', async () => {
    const mcpTool = utcpTool('NS.mcp_tool', { type: 'object', properties: {} }, 'mcp');
    const { client } = guardedClient([mcpTool], '<html>a page an mcp tool meant to return</html>');
    await expect(client.callTool('NS.mcp_tool', {})).resolves.toContain('<html>');
  });
});

describe('the compiled check is kept per distinct schema', () => {
  it('compiles one schema once, however many calls read it', () => {
    const first = checkFor(SEARCH.inputs);
    expect(checkFor(SEARCH.inputs)).toBe(first);
    expect(checkFor(READ_FILE.inputs)).not.toBe(first);
  });
});

describe('registering a manual installs the guards', () => {
  it('needs no code from the surface that registers it', async () => {
    const client = {
      config: {
        tool_repository: {
          getTool: async (name: string) => (name === SEARCH.name ? SEARCH : undefined),
          getTools: async () => [SEARCH],
        },
      },
      callTool: async () => ({ ok: true }),
      callToolStreaming: async function* () {
        yield { ok: true };
      },
      // Registration itself is not what this pins; a manual that cannot be
      // dialled still has to leave the client guarded.
      registerManual: async () => ({ success: false, errors: ['unreachable'] }),
    } as unknown as CodeModeUtcpClient;
    const before = client.callTool;
    expect(await registerManual(client, { name: 'NS' } as never)).toEqual({ ok: false, error: 'unreachable' });
    expect(client.callTool).not.toBe(before);
    await expect(client.callTool('NS.search', { body: { query: 'x' } })).rejects.toThrow(/arguments do not match/);
  });
});

describe('argumentRefusal', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it('is null for every call the generated example makes', async () => {
    for (const tool of [SEARCH, READ_FILE]) {
      const { client } = guardedClient([tool]);
      const args = tool === SEARCH ? { query: 'x' } : { body: { branch: 'main', path: 'a.md' } };
      await expect(argumentRefusal(client, tool.name, args)).resolves.toBeNull();
    }
  });
});

describe('a tool this server hosts as a route is left to that route', () => {
  /** What `toolDef` builds: the agent-tool route prefix on the `${API_URL}` origin. */
  const hostedHere = (name: string): Tool => {
    const tool = utcpTool(name, {
      type: 'object',
      properties: { body: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
      required: ['body'],
      additionalProperties: false,
    });
    (tool as { tool_call_template: Record<string, unknown> }).tool_call_template = {
      call_template_type: 'http',
      http_method: 'POST',
      url: '${API_URL}/api/agent/tools/write_file',
      body_field: 'body',
    };
    return tool;
  };

  it('passes a mismatching call on, so the route handler answers it', async () => {
    const tool = hostedHere('KB.write_file');
    const { client, callTool } = guardedClient([tool]);
    // Plainly wrong — and still forwarded: the route's own 400, with the route's
    // wording, is what the caller must get. Checking it here would check it
    // twice and replace that answer with ours.
    await client.callTool('KB.write_file', { body: {} });
    expect(callTool).toHaveBeenCalledWith('KB.write_file', { body: {} });
    await expect(argumentRefusal(client, 'KB.write_file', { body: {} })).resolves.toBeNull();
  });

  it('still checks a `.tool` that points at another endpoint of this same backend', async () => {
    // An administrator's `.tool` may legitimately target some other route of
    // ours, and that one has no tool handler to do the checking.
    const tool = utcpTool('NS.other', {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
      additionalProperties: false,
    });
    (tool as { tool_call_template: Record<string, unknown> }).tool_call_template = {
      call_template_type: 'http',
      http_method: 'GET',
      url: '${API_URL}/api/third-party/search',
    };
    const { client, callTool } = guardedClient([tool]);
    await expect(client.callTool('NS.other', { body: { query: 'x' } })).rejects.toThrow(/arguments do not match/);
    expect(callTool).not.toHaveBeenCalled();
  });

  it('still checks a tool on another host whose path happens to match', async () => {
    const tool = utcpTool('NS.elsewhere', {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
      additionalProperties: false,
    });
    (tool as { tool_call_template: Record<string, unknown> }).tool_call_template = {
      call_template_type: 'http',
      http_method: 'POST',
      url: 'https://elsewhere.example/api/agent/tools/write_file',
    };
    const { client, callTool } = guardedClient([tool]);
    await expect(client.callTool('NS.elsewhere', {})).rejects.toThrow(/arguments do not match/);
    expect(callTool).not.toHaveBeenCalled();
  });
});
