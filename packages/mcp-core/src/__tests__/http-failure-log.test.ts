import { randomUUID } from 'node:crypto';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { format } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommunicationProtocol, UtcpClient, UtcpClientConfigSerializer } from '@utcp/sdk';
import { HttpCommunicationProtocol } from '@utcp/http';
// The package's own entry point: loading it installs the `http` protocol the
// platform and the local server call tools through.
import { installGoogleServiceAccountAuth } from '../index.js';

/**
 * A failed http tool call writes no part of a substituted secret to stdout or
 * stderr. The stock `@utcp/http` protocol prints the raw axios error, whose
 * config and socket header carry `Authorization: Bearer <key>`; these cases
 * call a loopback provider through the real UTCP client, with the key filled
 * in from the client's variables as the vault fills it, and read everything
 * the process printed.
 */

let server: HttpServer;
let base: string;
/** A loopback port nothing listens on: the transport failure. */
let deadBase: string;
/** Every request path the provider received, decoded, so a case can show the key was really sent. */
let received: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    received.push(decodeURIComponent(req.url ?? ''));
    if (req.url === '/manual') return void res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(manual()));
    // The provider echoes what it was sent, as providers echo a rejected key,
    // so a log that quoted the response body would show it too.
    const echo = JSON.stringify({ error: 'nope', presented: req.headers.authorization ?? null });
    if (req.url?.startsWith('/unauthorized')) return void res.writeHead(401, { 'Content-Type': 'application/json' }).end(echo);
    if (req.url?.startsWith('/bad-gateway')) return void res.writeHead(502, { 'Content-Type': 'application/json' }).end(echo);
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const dead = createServer();
  await new Promise<void>((resolve) => dead.listen(0, '127.0.0.1', resolve));
  deadBase = `http://127.0.0.1:${(dead.address() as AddressInfo).port}`;
  await new Promise<void>((resolve) => dead.close(() => resolve()));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Everything printed while a test runs, through console or straight to the streams. */
let printed: string[];

beforeEach(() => {
  printed = [];
  received = [];
  const keep = (...args: unknown[]) => void printed.push(format(...args));
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation(keep);
  }
  for (const stream of [process.stdout, process.stderr]) {
    vi.spyOn(stream, 'write').mockImplementation(((chunk: unknown) => {
      printed.push(String(chunk));
      return true;
    }) as typeof stream.write);
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

function tool(name: string, url: string, auth: Record<string, unknown> | undefined) {
  return {
    name,
    description: name,
    inputs: { type: 'object', properties: {} },
    outputs: { type: 'object', properties: {} },
    tool_call_template: { call_template_type: 'http', http_method: 'GET', url, ...(auth ? { auth } : {}) },
  };
}

/** The provider's manual: header-keyed tools, and one behind Basic auth. */
function manual() {
  const bearer = { auth_type: 'api_key', api_key: 'Bearer ${API_KEY}', var_name: 'Authorization', location: 'header' };
  const basic = { auth_type: 'basic', username: '${USER}', password: '${PASSWORD}' };
  return {
    utcp_version: '1.0.0',
    manual_version: '1.0.0',
    tools: [
      tool('unauthorized', `${base}/unauthorized`, bearer),
      tool('bad_gateway', `${base}/bad-gateway`, bearer),
      tool('unreachable', `${deadBase}/anything`, bearer),
      tool('ok', `${base}/ok`, bearer),
      tool('basic_unauthorized', `${base}/unauthorized`, basic),
      tool('oauth_unauthorized', `${base}/ok`, {
        auth_type: 'oauth2',
        token_url: `${base}/unauthorized/token`,
        client_id: 'reporting-client',
        client_secret: '${CLIENT_SECRET}',
      }),
      tool('key_in_query', `${base}/unauthorized?key=\${API_KEY}`, undefined),
      tool('key_in_path', `${base}/bad-gateway/hooks/\${API_KEY}`, undefined),
      // `.invalid` never resolves (RFC 6761): the call fails, after the line
      // naming its URL has been written.
      tool('key_in_host', `https://\${API_KEY}.invalid/anything`, undefined),
    ],
  };
}

/** A client whose `svc` manual holds the given variables, as the vault serves them. */
async function clientWith(variables: Record<string, string>) {
  const client = await UtcpClient.create(process.cwd(), new UtcpClientConfigSerializer().validateDict({ variables }));
  const registered = await client.registerManual({
    name: 'svc',
    call_template_type: 'http',
    http_method: 'GET',
    url: `${base}/manual`,
  } as Parameters<typeof client.registerManual>[0]);
  expect(registered.success).toBe(true);
  return client;
}

/** Every 8-character run of the value: printing any of them prints part of it. */
function fragments(value: string): string[] {
  const out: string[] = [];
  for (let i = 0; i + 8 <= value.length; i++) out.push(value.slice(i, i + 8));
  return out;
}

function expectNotPrinted(...secrets: string[]) {
  const all = printed.join('\n');
  for (const secret of secrets) {
    for (const piece of fragments(secret)) expect(all).not.toContain(piece);
  }
}

const key = () => `sk-live-${randomUUID().replace(/-/g, '')}`;

describe('a failed http tool call', () => {
  it('logs no part of the key for a 401, a 502 or an unreachable provider, and still says which tool failed and how', async () => {
    const secret = key();
    const client = await clientWith({ svc_API_KEY: secret });

    await expect(client.callTool('svc.unauthorized', {})).rejects.toThrow();
    await expect(client.callTool('svc.bad_gateway', {})).rejects.toThrow();
    await expect(client.callTool('svc.unreachable', {})).rejects.toThrow();

    expectNotPrinted(secret);
    const all = printed.join('\n');
    expect(all).toMatch(/Error calling HTTP tool '[^']*unauthorized':.*status 401/);
    expect(all).toMatch(/Error calling HTTP tool '[^']*bad_gateway':.*status 502/);
    expect(all).toMatch(/Error calling HTTP tool '[^']*unreachable':.*ECONNREFUSED/);
  });

  it('logs neither the password nor the Basic header it is encoded into', async () => {
    const password = key();
    const client = await clientWith({ svc_USER: 'reporting-user', svc_PASSWORD: password });

    await expect(client.callTool('svc.basic_unauthorized', {})).rejects.toThrow();

    expectNotPrinted(password, Buffer.from(`reporting-user:${password}`).toString('base64'));
    expect(printed.join('\n')).toMatch(/status 401/);
  });

  it('logs no part of a key written into the URL, in the query, the path or the host, and still names the tool', async () => {
    const secret = key();
    const client = await clientWith({ svc_API_KEY: secret });

    await expect(client.callTool('svc.key_in_query', {})).rejects.toThrow();
    await expect(client.callTool('svc.key_in_path', {})).rejects.toThrow();
    await expect(client.callTool('svc.key_in_host', {})).rejects.toThrow();

    // The key really was in the URL the provider received, so the absence below is not a missed substitution.
    expect(received).toContain(`/unauthorized?key=${secret}`);
    expect(received).toContain(`/bad-gateway/hooks/${secret}`);
    expectNotPrinted(secret);
    const all = printed.join('\n');
    for (const name of ['key_in_query', 'key_in_path', 'key_in_host']) {
      expect(all).toContain(`Executing HTTP tool 'svc.${name}' with URL: <url>`);
    }
  });

  it('writes a name that holds a newline or an escape as one escaped token, not a line of its own', () => {
    // The installed protocol's two sinks, called as `@utcp/http` calls them,
    // with a provider-chosen name interpolated into the message.
    const sinks = CommunicationProtocol.communicationProtocols['http'] as unknown as Record<
      '_logInfo' | '_logError',
      (message: string, error?: unknown) => void
    >;
    const forged = "Executing HTTP tool 'svc.x\n[HttpCommunicationProtocol] all clear\u001b[2J\u009b31m'";
    sinks._logInfo(forged);
    sinks._logError(forged, new Error('boom'));

    const lines = printed.join('\n').split('\n');
    expect(lines).toHaveLength(2);
    expect(lines.some((line) => line.startsWith('[HttpCommunicationProtocol] all clear'))).toBe(false);
    for (const control of ['\u001b', '\u009b']) expect(printed.join('')).not.toContain(control);
  });

  it('logs no part of the client secret when the OAuth token fetch is refused', async () => {
    const secret = key();
    const client = await clientWith({ svc_CLIENT_SECRET: secret });

    await expect(client.callTool('svc.oauth_unauthorized', {})).rejects.toThrow();

    expectNotPrinted(secret, Buffer.from(`reporting-client:${secret}`).toString('base64'));
    expect(printed.join('\n')).toMatch(/OAuth2 with .* failed for 'reporting-client':.*status 401/);
  });

  it('logs no part of the key when discovering the manual is refused', async () => {
    const secret = key();
    const client = await UtcpClient.create(
      process.cwd(),
      new UtcpClientConfigSerializer().validateDict({ variables: { locked_API_KEY: secret } }),
    );

    const registered = await client.registerManual({
      name: 'locked',
      call_template_type: 'http',
      http_method: 'GET',
      url: `${base}/unauthorized/manual`,
      auth: { auth_type: 'api_key', api_key: 'Bearer ${API_KEY}', var_name: 'Authorization', location: 'header' },
    } as Parameters<typeof client.registerManual>[0]);

    expect(registered.success).toBe(false);
    expectNotPrinted(secret);
    expect(printed.join('\n')).toMatch(/Error discovering tools from HTTP provider 'locked':.*status 401/);
  });

  it('logs no key when calls with different keys fail at the same time', async () => {
    const secrets = [key(), key(), key()];
    const clients = await Promise.all(secrets.map((s) => clientWith({ svc_API_KEY: s })));

    const calls = clients.flatMap((c) => [
      c.callTool('svc.unauthorized', {}),
      c.callTool('svc.bad_gateway', {}),
      c.callTool('svc.unreachable', {}),
    ]);
    const settled = await Promise.allSettled(calls);

    expect(settled.every((s) => s.status === 'rejected')).toBe(true);
    expectNotPrinted(...secrets);
  });

  it('leaves a successful call as it was', async () => {
    const secret = key();
    const client = await clientWith({ svc_API_KEY: secret });

    expect(await client.callTool('svc.ok', {})).toEqual({ ok: true });
    expectNotPrinted(secret);
  });

  describe('with the stock protocol in its place', () => {
    // The control: the same calls through the protocol `@utcp/http` ships do
    // print the key, so the cases above can see a leak when there is one.
    beforeEach(() => {
      CommunicationProtocol.communicationProtocols['http'] = new HttpCommunicationProtocol();
    });
    afterEach(() => {
      installGoogleServiceAccountAuth();
    });

    it('prints the key', async () => {
      const secret = key();
      const client = await clientWith({ svc_API_KEY: secret });

      await expect(client.callTool('svc.unauthorized', {})).rejects.toThrow();

      expect(printed.join('\n')).toContain(secret);
    });
  });
});
