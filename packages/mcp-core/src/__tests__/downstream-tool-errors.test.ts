import { afterEach, describe, expect, it } from 'vitest';
import '@utcp/mcp'; // side effect: registers the stock 'mcp' protocol, which the install replaces
import { McpCommunicationProtocol } from '@utcp/mcp';
import { CodeModeUtcpClient } from '@utcp/code-mode';
import { CallTemplateSerializer, CommunicationProtocol, UtcpClientConfigSerializer, type CallTemplate } from '@utcp/sdk';
import { McpError, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  DownstreamToolError,
  downstreamErrorText,
  installDownstreamToolErrors,
  keepDownstreamToolErrors,
} from '../downstream-tool-errors.js';
import { SecretRedactor } from '../secret-redactor.js';
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

describe('DownstreamToolError.redactedWith', () => {
  it('passes on only the text fields the spec names, the secret out of every string the server wrote', () => {
    const KEY = 'sk-live-1234567890abcdef';
    const redactor = new SecretRedactor();
    redactor.remember(KEY);
    const failure = new DownstreamToolError(`refused ${KEY}`, [
      {
        type: 'text',
        text: `key ${KEY}`,
        annotations: { audience: ['user'], priority: 1, [KEY]: 'x' },
        _meta: { data: KEY, [KEY]: 'x' },
        [`x-${KEY}`]: 'an extension key',
      },
      { type: 'resource_link', uri: `https://x.example/?k=${KEY}`, name: 'link', description: `uses ${KEY}` },
      { type: 'resource', resource: { uri: `https://x.example/${KEY}`, text: KEY, [KEY]: 'x' } },
      { type: 'resource', resource: { uri: 'file:///a', mimeType: `application/${KEY}`, blob: `AAAA${KEY}` } },
      { type: 'image', data: KEY, mimeType: `image/png; key=${KEY}` },
      { type: 'resource_link', uri: 'file:///b', name: 'b', size: 42 },
      { type: `kind-${KEY}`, note: KEY },
    ] as unknown as CallToolResult['content']);
    const redacted = failure.redactedWith((text) => redactor.redact(text));
    expect(redacted.message).toBe('refused [redacted]');
    expect(redacted.content).toEqual([
      { type: 'text', text: 'key [redacted]', annotations: { audience: ['user'], priority: 1 } },
      { type: 'resource_link', uri: 'https://x.example/?k=[redacted]', name: 'link', description: 'uses [redacted]' },
      { type: 'resource', resource: { uri: 'https://x.example/[redacted]', text: '[redacted]' } },
      // The blob-only resource and the image are left out: a payload is not text.
      { type: 'resource_link', uri: 'file:///b', name: 'b', size: 42 },
    ]);
    // Nowhere: not in a field, a MIME type, a payload, or a key the server chose.
    expect(JSON.stringify(redacted.content)).not.toContain(KEY);
  });
});

describe('every failure a wrapped protocol lets through', () => {
  const KEY = 'sk-live-1234567890abcdef';
  const template = {
    name: 'stub',
    call_template_type: 'mcp',
    config: { mcpServers: { srv: { url: 'https://x.example/mcp', headers: { Authorization: `Bearer ${KEY}`, 'X-Pin': '4821' } } } },
  } as unknown as CallTemplate;
  /** A protocol whose call fails with `failure`, wrapped; its `callTool` answers what the wrap throws. */
  const failingWith = (failure: unknown, through: CallTemplate = template) => {
    const protocol = keepDownstreamToolErrors({
      _processMcpToolResult: (result: unknown) => result,
      callTool: async () => {
        throw failure;
      },
    }) as unknown as { callTool: (caller: unknown, tool: string, args: unknown, template: CallTemplate) => Promise<unknown> };
    return (args: unknown = {}) => protocol.callTool({}, 'stub.srv.echo', args, through).catch((err: unknown) => err);
  };

  it('keeps an AbortError the DOMException it was, its message and stack redacted', async () => {
    const thrown = await failingWith(new DOMException(`aborted while sending ${KEY}`, 'AbortError'))();
    expect(thrown).toBeInstanceOf(DOMException);
    expect(thrown).toMatchObject({ name: 'AbortError', message: 'aborted while sending [redacted]' });
    expect(String((thrown as Error).stack)).not.toContain(KEY);
  });

  it("puts an Error with a frozen failure's name and code in its place", async () => {
    const frozen = Object.freeze(Object.assign(new Error(`refused ${KEY}`), { code: 401, name: 'HttpError' }));
    expect(await failingWith(frozen)()).toMatchObject({ name: 'HttpError', code: 401, message: 'refused [redacted]' });
  });

  it("redacts a thrown error's data, response and cause, keeping its class and code, however its payload nests", async () => {
    const data: Record<string, unknown> = { echoed: KEY, nested: [{ [KEY]: `bad ${KEY}` }] };
    data.self = data;
    const failure = Object.assign(new McpError(-32603, `rejected ${KEY}`, data), {
      response: { status: 401, data: { error: `refused ${KEY}` } },
    });
    Object.defineProperty(failure, 'cause', { value: new Error(`inner: ${KEY}`), configurable: true });
    const thrown = (await failingWith(failure)()) as McpError & { response: unknown; cause: Error };
    expect(thrown).toBeInstanceOf(McpError);
    expect(thrown.code).toBe(-32603);
    expect(thrown.message).toContain('rejected [redacted]');
    const payload = thrown.data as Record<string, unknown>;
    expect(payload).toMatchObject({ echoed: '[redacted]', nested: [{ '[redacted]': 'bad [redacted]' }] });
    expect(payload.self).toBe(payload);
    expect(thrown.response).toEqual({ status: 401, data: { error: 'refused [redacted]' } });
    expect(thrown.cause.message).toBe('inner: [redacted]');
    // A frozen error comes back as an Error carrying the same fields, redacted.
    const frozen = Object.freeze(Object.assign(new Error(`refused ${KEY}`), { code: 401, data: { echoed: KEY } }));
    expect(await failingWith(frozen)()).toMatchObject({ code: 401, message: 'refused [redacted]', data: { echoed: '[redacted]' } });
  });

  it('redacts a thrown string', async () => {
    expect(await failingWith(`refused ${KEY}`)()).toBe('refused [redacted]');
  });

  it("withholds a failure that quotes the caller's keys, numbers or escaped strings, matched or not", async () => {
    const quoting = (text: string) => new DownstreamToolError(text, [{ type: 'text', text }]);
    const answer = async (failure: DownstreamToolError, args: unknown) => ((await failingWith(failure)(args)) as DownstreamToolError).message;
    expect(await answer(quoting("Unrecognized key 'sk-live-1234'"), { 'sk-live-1234': 1 })).toBe('[redacted]');
    expect(await answer(quoting("Unrecognized key 'zz-none-9999'"), { 'zz-none-9999': 1 })).toBe('[redacted]');
    // Sent as `sk-live-1234"x`, quoted JSON-escaped.
    expect(await answer(quoting('{"error":"No project sk-live-1234\\"x"}'), { text: 'sk-live-1234"x' })).toBe('[redacted]');
    // The server quoting the PIN itself reads the same whichever PIN the caller sent.
    expect(await answer(quoting('PIN 4821 is wrong'), { pin: 4821 })).toBe('[redacted]');
    expect(await answer(quoting('PIN 4821 is wrong'), { pin: 1111 })).toBe('[redacted]');
    // A failure that quotes none of it and no credential goes as it came.
    expect(await answer(quoting('This tool requires a Business plan.'), { query: 'Quarterly review' })).toBe('This tool requires a Business plan.');
  });

  it('counts a boolean or null the caller sent as theirs, so a guess at a key spelled the same reads the same right or wrong', async () => {
    const keyed = {
      name: 'stub',
      call_template_type: 'mcp',
      config: { mcpServers: { srv: { url: 'https://x.example/mcp', headers: { 'X-Api-Key': 'true' } } } },
    } as unknown as CallTemplate;
    const answer = async (text: string, args: unknown) =>
      ((await failingWith(new DownstreamToolError(text, [{ type: 'text', text }]), keyed)(args)) as DownstreamToolError).message;
    expect(await answer('got true', { f: true })).toBe('[redacted]');
    expect(await answer('got false', { f: false })).toBe('[redacted]');
    expect(await answer('got null', { f: null })).toBe('[redacted]');
    expect(await answer('got nothing', { f: false })).toBe('got nothing');
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

  it("takes every credential the call carried out of the server's words", async () => {
    installDownstreamToolErrors();
    const server = await startFakeMcpServer('notion');
    cleanups.push(() => server.stop());
    // One credential substituted from a variable, one spelled out in full.
    const client = await CodeModeUtcpClient.create(
      process.cwd(),
      new UtcpClientConfigSerializer().validateDict({
        // The manual's name has a `-`: UTCP registers it as `my_notion`, and its variables under `my__notion_`.
        variables: {
          my__notion_TOKEN: 'sk-live-1234567890abcdef',
          my__notion_A: 'a',
          my__notion_B: 'middle|secret-9876',
          my__notion_C: 'd',
        },
      }),
    );
    cleanups.push(() => client.close());
    const template = serializer.validateDict({
      name: 'my-notion',
      call_template_type: 'mcp',
      config: {
        mcpServers: {
          srv: {
            transport: 'http',
            url: server.url,
            timeout: 10,
            terminate_on_close: true,
            // `X-Trace` is not credential-named, and its middle value contains the separator.
            headers: {
              Authorization: 'Bearer ${TOKEN}',
              'X-Api-Key': 'literal-key-abcdef123456',
              'X-Trace': '${A}|${B}|${C}',
            },
          },
        },
      },
    });
    expect(await registerManual(client, template)).toEqual({ ok: true });
    server.reportToolErrors(
      'Rejected: token sk-live-1234567890abcdef (or its head sk-live-1234…), key literal-key-abcdef123456, trace middle|secret-9876.',
    );

    const tool = { ...echo, utcpName: 'my_notion.srv.echo', mcpName: 'my_notion_srv_echo', manualName: 'my_notion' };
    const result = await dispatchToolCall(client, tool, {});

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      { type: 'text', text: 'Rejected: token [redacted] (or its head [redacted]…), key [redacted], trace [redacted].' },
    ]);
    // With the caller's arguments about, a failure that holds a credential is not quoted at all.
    expect((await dispatchToolCall(client, tool, { text: 'hi' })).content).toEqual([{ type: 'text', text: '[redacted]' }]);
  });

  it('takes a short credential out even glued to other text, and a short value that is not one only where it stands alone', async () => {
    installDownstreamToolErrors();
    const server = await startFakeMcpServer('notion');
    cleanups.push(() => server.stop());
    const client = await CodeModeUtcpClient.create(
      process.cwd(),
      new UtcpClientConfigSerializer().validateDict({ variables: { short_SESSION_TOKEN: 'a9B2', short_REGION: 'us' } }),
    );
    cleanups.push(() => client.close());
    // Neither header is credential-named: only the variable's name says `a9B2` is a credential.
    const template = serializer.validateDict({
      name: 'short',
      call_template_type: 'mcp',
      config: {
        mcpServers: {
          srv: {
            transport: 'http',
            url: server.url,
            timeout: 10,
            terminate_on_close: true,
            headers: { 'X-Trace': '${SESSION_TOKEN}', 'X-Region': '${REGION}' },
          },
        },
      },
    });
    expect(await registerManual(client, template)).toEqual({ ok: true });
    server.reportToolErrors('Session xa9B2y refused for users in region us.');

    const result = await dispatchToolCall(client, { ...echo, utcpName: 'short.srv.echo', mcpName: 'short_srv_echo', manualName: 'short' }, {});

    expect(result.content).toEqual([{ type: 'text', text: 'Session x[redacted]y refused for users in region [redacted].' }]);
  });

  /** A manual at `url` whose server sends `${TOKEN}` in a header no credential rule would name. */
  const tracedManual = (name: string, url: string) =>
    serializer.validateDict({
      name,
      call_template_type: 'mcp',
      config: { mcpServers: { srv: { transport: 'http', url, timeout: 10, terminate_on_close: true, headers: { 'X-Trace': '${TOKEN}' } } } },
    });
  const echoOf = (manual: string): ProxiedTool => ({ ...echo, utcpName: `${manual}.srv.echo`, mcpName: `${manual}_srv_echo`, manualName: manual });

  it("keeps each manual's own values when two register on one client at once", async () => {
    installDownstreamToolErrors();
    const [alpha, beta] = await Promise.all([startFakeMcpServer('alpha'), startFakeMcpServer('beta')]);
    cleanups.push(() => alpha.stop(), () => beta.stop());
    const client = await CodeModeUtcpClient.create(
      process.cwd(),
      new UtcpClientConfigSerializer().validateDict({ variables: { alpha_TOKEN: 'alpha-value-1234', beta_TOKEN: 'beta-value-5678' } }),
    );
    cleanups.push(() => client.close());
    expect(
      await Promise.all([registerManual(client, tracedManual('alpha', alpha.url)), registerManual(client, tracedManual('beta', beta.url))]),
    ).toEqual([{ ok: true }, { ok: true }]);
    alpha.reportToolErrors('refused alpha-value-1234');
    beta.reportToolErrors('refused beta-value-5678');

    expect((await dispatchToolCall(client, echoOf('alpha'), {})).content).toEqual([{ type: 'text', text: 'refused [redacted]' }]);
    expect((await dispatchToolCall(client, echoOf('beta'), {})).content).toEqual([{ type: 'text', text: 'refused [redacted]' }]);
  });

  it('redacts the value a later registration filled in, as after a session recovery', async () => {
    installDownstreamToolErrors();
    const server = await startFakeMcpServer('alpha');
    cleanups.push(() => server.stop());
    const config = new UtcpClientConfigSerializer().validateDict({ variables: { alpha_TOKEN: 'first-value-1234' } });
    const client = await CodeModeUtcpClient.create(process.cwd(), config);
    cleanups.push(() => client.close());
    expect(await registerManual(client, tracedManual('alpha', server.url))).toEqual({ ok: true });

    // The credential changes, and the manual registers again with it.
    client.config.variables = { alpha_TOKEN: 'second-value-5678' };
    await client.deregisterManual('alpha');
    expect(await registerManual(client, tracedManual('alpha', server.url))).toEqual({ ok: true });
    server.reportToolErrors('refused second-value-5678');

    expect((await dispatchToolCall(client, echoOf('alpha'), {})).content).toEqual([{ type: 'text', text: 'refused [redacted]' }]);
  });

  /**
   * A client and the verdict of registering manual `name` at `url`, which
   * sends `Authorization: Bearer ${TOKEN}`. The token comes from the process
   * environment, the last tier the substitutor reads: a value in the client's
   * own `variables` is substituted itself when the client is built.
   */
  async function registerWithToken(
    name: string,
    url: string,
    token: string,
    /** More variables (`${NAME}` to value), each sent in an `X-<NAME>` header; and a client to use. */
    more: { variables?: Record<string, string>; client?: CodeModeUtcpClient } = {},
  ) {
    const variables = { TOKEN: token, ...more.variables };
    for (const [variable, value] of Object.entries(variables)) process.env[`${name}_${variable}`] = value;
    cleanups.push(async () => {
      for (const variable of Object.keys(variables)) delete process.env[`${name}_${variable}`];
    });
    const client = more.client ?? (await CodeModeUtcpClient.create(process.cwd(), null));
    if (!more.client) cleanups.push(() => client.close());
    const headers: Record<string, string> = { Authorization: 'Bearer ${TOKEN}' };
    for (const variable of Object.keys(more.variables ?? {})) headers[`X-${variable}`] = `\${${variable}}`;
    const template = serializer.validateDict({
      name,
      call_template_type: 'mcp',
      config: { mcpServers: { srv: { transport: 'http', url, timeout: 10, terminate_on_close: true, headers } } },
    });
    return { client, registration: await registerManual(client, template) };
  }

  it('takes the credentials out of a failure the server threw, not only one it reported', async () => {
    installDownstreamToolErrors();
    const server = await startFakeMcpServer('notion');
    cleanups.push(() => server.stop());
    const { client } = await registerWithToken('thrown', server.url, 'sk-live-1234567890abcdef');
    server.failToolCalls('rejected sk-live-1234567890abcdef');

    const result = await dispatchToolCall(client, { ...echo, utcpName: 'thrown.srv.echo', mcpName: 'thrown_srv_echo', manualName: 'thrown' }, {});

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('rejected [redacted]');
    expect(text).not.toContain('sk-live-1234567890abcdef');
    // The same failure, as the token classifier receives it: still the McpError it was, code and all.
    const thrown = await client.callTool('thrown.srv.echo', { text: 'hi' }).catch((err: unknown) => err);
    expect(thrown).toBeInstanceOf(McpError);
    expect(thrown).toMatchObject({ code: -32603 });
    expect(`${(thrown as Error).message} ${(thrown as Error).stack}`).not.toContain('sk-live-1234567890abcdef');
  });

  it('withholds a failure that quotes what the caller sent, so a guess at the key comes back the same right or wrong', async () => {
    installDownstreamToolErrors();
    const server = await startFakeMcpServer('notion');
    cleanups.push(() => server.stop());
    const { client } = await registerWithToken('quoted', server.url, 'sk-live-Q7xZ2abcdefgh');
    server.reportToolErrors("Project '{text}' not found");
    const call = (text: string) =>
      dispatchToolCall(client, { ...echo, utcpName: 'quoted.srv.echo', mcpName: 'quoted_srv_echo', manualName: 'quoted' }, { text });

    // `sk-live-Q7xZ` is a head of the key, `sk-live-Q7xA` is not: both come back the same.
    expect((await call('sk-live-Q7xZ')).content).toEqual([{ type: 'text', text: '[redacted]' }]);
    expect((await call('sk-live-Q7xA')).content).toEqual([{ type: 'text', text: '[redacted]' }]);
  });

  it("withholds a failure that quotes the caller's keys, a field the tool's schema declares included", async () => {
    installDownstreamToolErrors();
    const server = await startFakeMcpServer('notion');
    cleanups.push(() => server.stop());
    const { client } = await registerWithToken('schema', server.url, 'sk-live-1234567890abcdef');
    server.reportToolErrors('text: {text} is not a page');

    const result = await dispatchToolCall(
      client,
      { ...echo, utcpName: 'schema.srv.echo', mcpName: 'schema_srv_echo', manualName: 'schema' },
      { text: 'Quarterly plan' },
    );

    // `text` is the caller's key as much as the tool's field: a guess sent as a key reads the same either way.
    expect(result.content).toEqual([{ type: 'text', text: '[redacted]' }]);
  });

  it('refuses a value every call would read as another variable, naming the variable and not the value', async () => {
    const server = await startFakeMcpServer('notion');
    cleanups.push(() => server.stop());

    const { client, registration } = await registerWithToken('dollar', server.url, 'Pa$$w0rdSecretTail9');

    expect(registration.ok).toBe(false);
    const error = (registration as { error: string }).error;
    expect(error).toContain('${TOKEN}');
    expect(error).not.toContain('w0rdSecretTail9');
    expect(await client.getTools()).toEqual([]);
  });

  it("takes a refused manual's tools off even when closing its connection fails", async () => {
    const server = await startFakeMcpServer('notion');
    cleanups.push(() => server.stop());
    const client = await CodeModeUtcpClient.create(process.cwd(), null);
    cleanups.push(() => client.close());
    client.deregisterManual = async () => {
      throw new Error('the connection would not close');
    };

    const { registration } = await registerWithToken('stuck', server.url, 'Pa$$w0rdSecretTail9', { client });

    expect(registration.ok).toBe(false);
    expect(await client.getTools()).toEqual([]);
  });

  it('takes the credentials out of what a server quoted back when registration failed', async () => {
    const server = await startFakeMcpServer('notion');
    cleanups.push(() => server.stop());
    server.failWithAuthError(true, 'Unauthorized for users in us: {authorization}');

    const { registration } = await registerWithToken('refused', server.url, 'a9B2', { variables: { REGION: 'us' } });

    expect(registration.ok).toBe(false);
    const error = (registration as { error: string }).error;
    // The server's words arrive; the token is out of them even glued, since it went in a credential-named
    // header; the region, which did not, is out only where it stands alone.
    expect(error).toContain('Unauthorized for users in [redacted]: Bearer [redacted]');
    expect(error).not.toContain('a9B2');
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
