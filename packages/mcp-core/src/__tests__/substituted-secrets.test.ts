import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@utcp/http';
import { CallTemplateSerializer } from '@utcp/sdk';
import { CodeModeUtcpClient, type CodeModeUtcpClient as Client } from '@utcp/code-mode';
import { dispatchToolCall, registerManual } from '../dispatch.js';
import { installCallGuards } from '../call-guards.js';
import { runToolChain } from '../chain-runtime.js';
import type { ProxiedTool } from '../proxied-tool.js';
import {
  inSubstitutionScope,
  openSubstitutionScope,
  recordSubstitutions,
  redactSubstitutedFailure,
} from '../substituted-secrets.js';

/**
 * A failing tool call never quotes back a value the client substituted into
 * it. Over a real UTCP client and a real HTTP round trip, on every way a tool
 * is called: MCP dispatch (`callToolStreaming`), a chain (`call_tool_chain`,
 * bridged to `callTool`), and `callTool` itself, which the in-process agent
 * and the REST-hosted chain call.
 *
 * The value is a synthetic marker, not a secret. It carries a quote so the
 * JSON-escaped spelling the URL scheme check uses is covered as well.
 */

const SECRET = 'synthetic-marker-7f3a"9c41';
const QUOTED = JSON.stringify(SECRET).slice(1, -1);
const ENCODED = encodeURIComponent(SECRET);

let server: Server | undefined;
let client: Client | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  await client?.close().catch(() => {});
  client = undefined;
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
});

/** The forms the marker could be quoted in. */
function expectNoSecret(text: string): void {
  expect(text).not.toContain(SECRET);
  expect(text).not.toContain(QUOTED);
  expect(text).not.toContain(ENCODED);
  expect(text).not.toContain('7f3a');
}

/**
 * A loopback server serving a UTCP manual with one tool, `query`, at `toolUrl`
 * (filled in once the port is known), and answering every other request with
 * a 401 whose body echoes the request's URL — as providers echo a rejected key.
 */
async function serve(toolUrl: (base: string) => string): Promise<string> {
  const tools: Record<string, unknown>[] = [];
  server = createServer((req, res) => {
    if ((req.url ?? '').startsWith('/manual')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ utcp_version: '1.1.0', manual_version: '1.0.0', tools }));
      return;
    }
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: `invalid key in ${decodeURIComponent(req.url ?? '')}`, echoed: req.url }));
  });
  const port = await new Promise<number>((r) => server!.listen(0, () => r((server!.address() as { port: number }).port)));
  const base = `http://127.0.0.1:${port}`;
  tools.push({
    name: 'query',
    description: 'Query the other service.',
    inputs: { type: 'object', properties: {} },
    outputs: { type: 'object', properties: {} },
    tags: [],
    tool_call_template: { call_template_type: 'http', http_method: 'GET', url: toolUrl(base), content_type: 'application/json' },
  });
  return base;
}

async function connect(base: string): Promise<Client> {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  client = await CodeModeUtcpClient.create(process.cwd(), { variables: { NS_KEY: SECRET } } as never);
  const manual = new CallTemplateSerializer().validateDict({
    name: 'NS',
    call_template_type: 'http',
    http_method: 'GET',
    url: `${base}/manual`,
    content_type: 'application/json',
  });
  expect(await registerManual(client, manual)).toEqual({ ok: true });
  return client;
}

const TOOL: ProxiedTool = {
  utcpName: 'NS.query',
  mcpName: 'NS_query',
  description: 'Query the other service.',
  inputSchema: { type: 'object', properties: {} },
  manualName: 'NS',
};

/** Every surface's answer to one failing call, as text. */
async function everySurface(c: Client): Promise<{ mcp: string; chain: string; direct: string }> {
  const mcp = await dispatchToolCall(c, TOOL, {});
  expect(mcp.isError).toBe(true);
  const chain = await runToolChain(c, 'return NS.query({});', 10_000);
  expect(chain.ok).toBe(false);
  const direct = await c.callTool('NS.query', {}).then(
    () => 'no failure',
    (err: unknown) => {
      const e = err as { message?: string; stack?: string; data?: unknown };
      return `${e.message} ${e.stack} ${JSON.stringify(e.data ?? null)}`;
    },
  );
  return { mcp: JSON.stringify(mcp), chain: JSON.stringify(chain), direct };
}

describe('a failing tool call never quotes a substituted value', () => {
  it('a plain-http URL carrying it in its query is refused without the value', async () => {
    const base = await serve(() => 'http://10.0.47.4:4555/query?key=${KEY}');
    const surfaces = await everySurface(await connect(base));
    for (const text of Object.values(surfaces)) {
      // The refusal is still the URL scheme check's, naming the variable instead.
      expect(text).toMatch(/URL must use HTTPS/);
      expect(text).toContain('key=${KEY}');
      expectNoSecret(text);
    }
  });

  it('an upstream that echoes it back in its refusal is quoted without it', async () => {
    const base = await serve((b) => `${b}/query?key=\${KEY}`);
    const surfaces = await everySurface(await connect(base));
    for (const text of Object.values(surfaces)) {
      // The provider's own reason still reaches the caller, naming the variable.
      expect(text).toMatch(/invalid key in \/query\?key=\$\{KEY\}/);
      expectNoSecret(text);
    }
  });

  it('a manual that cannot be registered is reported without it', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    client = await CodeModeUtcpClient.create(process.cwd(), { variables: { NS_KEY: SECRET } } as never);
    const manual = new CallTemplateSerializer().validateDict({
      name: 'NS',
      call_template_type: 'http',
      http_method: 'GET',
      url: 'http://10.0.47.4:4555/manual?key=${KEY}',
      content_type: 'application/json',
    });
    const result = await registerManual(client, manual);
    expect(result.ok).toBe(false);
    const error = (result as { error: string }).error;
    expect(error).toContain('${KEY}');
    expectNoSecret(error);
  });
});

describe('redactSubstitutedFailure', () => {
  /** A scope holding the marker as `${KEY}` had substituted it. */
  async function scopeWithSecret() {
    const substitutor = { _getVariable: async (key: string) => (key === 'KEY' ? SECRET : '') };
    recordSubstitutions({ substituteCallTemplateVariables: () => {}, variableSubstitutor: substitutor } as never);
    const scope = openSubstitutionScope();
    await inSubstitutionScope(scope, () => substitutor._getVariable('KEY'));
    return scope;
  }

  it('keeps the error, its class and status, and its cause chain redacted', async () => {
    const scope = await scopeWithSecret();
    const cause = new Error(`dial failed for ${SECRET}`);
    const err = Object.assign(new TypeError(`refused ${SECRET}`, { cause }), {
      status: 401,
      response: { status: 401, data: { error: `bad key ${SECRET}` } },
    });
    const out = redactSubstitutedFailure(err, scope);
    expect(out).toBe(err);
    expect(out).toBeInstanceOf(TypeError);
    expect(err.status).toBe(401);
    expect(err.message).toBe('refused ${KEY}');
    expect(cause.message).toBe('dial failed for ${KEY}');
    expect(err.response.data).toEqual({ error: 'bad key ${KEY}' });
    expectNoSecret(String(err.stack));
  });

  it('answers a fresh error when the one thrown cannot be rewritten', async () => {
    const scope = await scopeWithSecret();
    const frozen = Object.freeze(Object.assign(new Error(`refused ${SECRET}`), { status: 403 }));
    const out = redactSubstitutedFailure(frozen, scope) as Error & { status?: number };
    expect(out).not.toBe(frozen);
    expect(out.message).toBe('refused ${KEY}');
    expect(out.status).toBe(403);
  });

  it('withholds upstream data it cannot serialise rather than serve it unchecked', async () => {
    const scope = await scopeWithSecret();
    const data: Record<string, unknown> = { error: `bad key ${SECRET}` };
    data.self = data;
    const err = Object.assign(new Error('HTTP 401'), { data });
    redactSubstitutedFailure(err, scope);
    expectNoSecret(JSON.stringify(err.data));
  });

  it('leaves a failure alone when nothing was substituted', () => {
    const err = new Error(`refused ${SECRET}`);
    expect(redactSubstitutedFailure(err, openSubstitutionScope())).toBe(err);
    expect(err.message).toContain(SECRET);
  });
});

describe('a short substituted value', () => {
  it('is redacted all the same, and the marker it leaves is not garbled', async () => {
    // `E` occurs in the marker `${KEY}` itself: one pass, so it is not re-marked.
    const substitutor = { _getVariable: async (key: string) => (key === 'KEY' ? 'E' : '') };
    recordSubstitutions({ substituteCallTemplateVariables: () => {}, variableSubstitutor: substitutor } as never);
    const scope = openSubstitutionScope();
    await inSubstitutionScope(scope, () => substitutor._getVariable('KEY'));
    const err = Object.assign(new TypeError('pin E refused'), { status: 401 });
    const out = redactSubstitutedFailure(err, scope);
    // Rewritten in place: class and status survive, nothing fell back to a fresh error.
    expect(out).toBe(err);
    expect(err.message).toBe('pin ${KEY} refused');
  });
});

describe('recordSubstitutions', () => {
  it('refuses a client that substitutes through a substitutor it does not recognise', () => {
    expect(() => recordSubstitutions({ substituteCallTemplateVariables: () => {} } as never)).toThrow(/could not be redacted/);
    expect(() =>
      recordSubstitutions({ substituteCallTemplateVariables: () => {}, variableSubstitutor: { getVariable() {} } } as never),
    ).toThrow(/could not be redacted/);
  });

  it('leaves a client that substitutes nothing alone', () => {
    expect(() => recordSubstitutions({} as never)).not.toThrow();
  });
});

describe('a streamed call', () => {
  it('redacts a failure the stream raises while it is being closed', async () => {
    const substitutor = { _getVariable: async (key: string) => (key === 'KEY' ? SECRET : '') };
    const double = {
      config: { tool_repository: { getTool: async () => undefined } },
      substituteCallTemplateVariables: () => {},
      variableSubstitutor: substitutor,
      async *callToolStreaming() {
        await substitutor._getVariable('KEY');
        try {
          yield 'first';
          yield 'second';
        } finally {
          // eslint-disable-next-line no-unsafe-finally
          throw Object.assign(new Error(`close failed for ${SECRET}`), { data: { echoed: SECRET } });
        }
      },
    };
    installCallGuards(double as never);
    const stream = (double as unknown as Client).callToolStreaming('NS.query', {});
    const failure = await (async () => {
      for await (const chunk of stream) {
        expect(chunk).toBe('first');
        break; // Stop early: the guard closes the stream underneath.
      }
    })().then(
      () => undefined,
      (err: unknown) => err as Error & { data?: unknown },
    );
    expect(failure?.message).toBe('close failed for ${KEY}');
    expectNoSecret(`${failure?.message} ${failure?.stack} ${JSON.stringify(failure?.data)}`);
  });
});

describe('overlapping substituted values', () => {
  /** A scope holding each of `values` as its `${NAME}` had substituted it. */
  async function scopeWith(values: Record<string, string>) {
    const substitutor = { _getVariable: async (key: string) => values[key] ?? '' };
    recordSubstitutions({ substituteCallTemplateVariables: () => {}, variableSubstitutor: substitutor } as never);
    const scope = openSubstitutionScope();
    await inSubstitutionScope(scope, async () => {
      for (const key of Object.keys(values)) await substitutor._getVariable(key);
    });
    return scope;
  }

  it('leave no part of either value, whichever is matched first', async () => {
    const scope = await scopeWith({ KEY: 'abcdef12', OTHER: 'ef12ghij' });
    const err = new Error('refused abcdef12ghij and ef12ghij');
    redactSubstitutedFailure(err, scope);
    expect(err.message).toBe('refused ${KEY}${OTHER} and ${OTHER}');
  });

  it('leave the outer marker when one value lies inside another', async () => {
    const scope = await scopeWith({ KEY: 'secret-long', OTHER: 'long' });
    const err = new Error('refused secret-long, then long');
    redactSubstitutedFailure(err, scope);
    expect(err.message).toBe('refused ${KEY}, then ${OTHER}');
  });
});

describe('a streamed call that fails as it opens', () => {
  it('is redacted all the same', async () => {
    const substitutor = { _getVariable: async (key: string) => (key === 'KEY' ? SECRET : '') };
    const double = {
      // A step before the stream opens has already substituted the value.
      config: {
        tool_repository: {
          getTool: async () => {
            await substitutor._getVariable('KEY');
            return undefined;
          },
        },
      },
      substituteCallTemplateVariables: () => {},
      variableSubstitutor: substitutor,
      // Not a generator: it throws as it is called, before any stream exists.
      callToolStreaming(): AsyncGenerator<unknown> {
        throw new Error(`cannot open ${SECRET}`);
      },
    };
    installCallGuards(double as never);
    const failure = await (async () => {
      for await (const _ of (double as unknown as Client).callToolStreaming('NS.query', {})) void _;
    })().then(
      () => undefined,
      (err: unknown) => err as Error,
    );
    expect(failure?.message).toBe('cannot open ${KEY}');
    expectNoSecret(`${failure?.message} ${failure?.stack}`);
  });
});
