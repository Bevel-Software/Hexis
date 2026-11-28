import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createHexisMcpServer, type HexisMcpConfig } from '../index.js';
// The deployment's own 401 sentence, which this suite's stub deployment answers with.
import { REVOKED_KEY_SENTENCE } from '../deployment.js';

/**
 * INTEGRATION: a connection key revoked while this process holds it stops
 * every call at once, local-only tools included.
 *
 * The stub deployment serves one LOCAL-ONLY manual with two tools that call
 * the stub's own `/local/*` receiver: `secret` sends a vault variable (which
 * the local server caches for five minutes), `plain` sends nothing from the
 * vault. Neither needs the deployment to run, which is exactly why the
 * revocation used to pass them by. Revoking flips every key-authenticated
 * route to the deployment's own 401.
 */

const KEY = 'bevel_liveUntilRevoked';
const SECRET = 'vault-value-must-not-leave-after-revoke';

let httpServer: http.Server | null = null;
let base = '';
let revoked = false;
/** The sentence the deployment's 401 carries (a switched-off account gets its own). */
let refusalSentence = REVOKED_KEY_SENTENCE;
/** Held, the manuals route answers only once it settles. Set it with holdDiscovery() only. */
let holdManuals: Promise<void> | null = null;
/** Settles holdManuals. afterEach calls it, so a failed test never leaves a request held. */
let releaseManuals: () => void = () => {};
/** Holds discovery mid-download until the returned release (or afterEach) lets it go. */
function holdDiscovery(): () => void {
  holdManuals = new Promise<void>((resolve) => (releaseManuals = resolve));
  return releaseManuals;
}
/** How long the deployment's MCP endpoint takes to answer. */
let mcpDelayMs = 0;
/** Discovery fails: the manuals route answers 5xx. */
let discoveryFails = false;
/** The deployment advertises per-listing tool hints. */
let advertiseHints = false;
/** Every invocation the local receiver got, by tool, with the secret header it carried. */
const received: { tool: string; secret: string | undefined }[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  revoked = false;
  discoveryFails = false;
  advertiseHints = false;
  refusalSentence = REVOKED_KEY_SENTENCE;
  releaseManuals();
  holdManuals = null;
  mcpDelayMs = 0;
  received.length = 0;
});

beforeAll(async () => {
  httpServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    req.on('end', () => {
      void (async () => {
        const pathname = (req.url ?? '/').split('?')[0]!;
        const json = (status: number, payload: unknown): void => {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(payload));
        };
        if (pathname === '/api/config') {
          return json(200, { mcpUrl: `${base}/api/mcp`, agentInstructions: true, toolHints: advertiseHints });
        }
        const receiver = /^\/local\/(secret|plain)$/.exec(pathname);
        if (receiver) {
          received.push({ tool: receiver[1]!, secret: req.headers['x-secret'] as string | undefined });
          return json(200, { ok: true });
        }
        if (pathname === '/local/manual') {
          const tool = (name: string, headers?: Record<string, string>) => ({
            name,
            description: `the ${name} local tool`,
            inputs: { type: 'object', properties: {} },
            outputs: { type: 'object', properties: {} },
            tags: [],
            tool_call_template: {
              call_template_type: 'http',
              http_method: 'POST',
              url: `${base}/local/${name}`,
              content_type: 'application/json',
              ...(headers ? { headers } : {}),
            },
          });
          return json(200, {
            utcp_version: '1.1.0',
            manual_version: '1.0.0',
            tools: [tool('secret', { 'X-Secret': '${SECRET}' }), tool('plain')],
          });
        }
        // Everything below is key-authenticated, as on a real deployment.
        if (revoked || req.headers.authorization !== `Bearer ${KEY}`) {
          res.writeHead(401, {
            'Content-Type': 'application/json',
            'WWW-Authenticate': 'Bearer error="invalid_token", error_description="Invalid or revoked connection key"',
          });
          res.end(JSON.stringify({ error: refusalSentence }));
          return;
        }
        if (pathname === '/api/agent/instructions') return json(200, { instructions: 'Search the knowledge base.' });
        if (pathname === '/api/agent/all-tools' && holdManuals) await holdManuals;
        if (pathname === '/api/agent/all-tools' && discoveryFails) return json(500, {});
        if (pathname === '/api/agent/all-tools') {
          return json(200, {
            manuals: [{ name: 'localbox', call_template_type: 'http', http_method: 'GET', url: `${base}/local/manual` }],
          });
        }
        if (pathname === '/api/agent/tools/list_local_tools') {
          return json(200, { tools: [{ name: 'localbox', slug: 'localbox', path: 'Plugins/Everyone/localbox.tool' }] });
        }
        if (pathname === '/api/agent/local-tools/localbox/variables') {
          return json(200, { variables: { SECRET } });
        }
        if (pathname === '/api/mcp') {
          if (mcpDelayMs) await new Promise((resolve) => setTimeout(resolve, mcpDelayMs));
          const parsed = body ? (JSON.parse(body) as unknown) : undefined;
          const mcp = new Server({ name: 'stub-deployment', version: '0.0.0' }, { capabilities: { tools: {} } });
          mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: [{ name: 'list_files', description: 'List files.', inputSchema: { type: 'object' as const } }],
          }));
          mcp.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: 'text' as const, text: 'listed' }] }));
          const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
          res.on('close', () => {
            void transport.close();
            void mcp.close();
          });
          await mcp.connect(transport);
          await transport.handleRequest(req, res, parsed);
          return;
        }
        json(404, {});
      })().catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
  });
  await new Promise<void>((resolve) => httpServer!.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(httpServer!.address() as { port: number }).port}`;
});

afterAll(async () => {
  if (httpServer) {
    httpServer.closeAllConnections?.();
    await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
  }
});

async function start(extra: Partial<HexisMcpConfig> = {}): Promise<{
  client: Client;
  stderr: string[];
  rejections: string[];
  closed: Promise<void>;
  toolNamed: (suffix: string) => Promise<string>;
  shutdown: () => Promise<void>;
  config: HexisMcpConfig;
}> {
  const stderr: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    stderr.push(args.map(String).join(' '));
  });
  const rejections: string[] = [];
  const config: HexisMcpConfig = {
    baseUrl: base,
    connectionKey: KEY,
    onConnectionKeyRejected: (sentence) => rejections.push(sentence),
    ...extra,
  };
  const handle = await createHexisMcpServer(config, '0.0.0', { catalogCheck: false });
  await handle.ready;
  const client = new Client({ name: 'probe', version: '0.0.0' }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const closed = new Promise<void>((resolve) => {
    client.onclose = () => resolve();
  });
  await handle.server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    stderr,
    rejections,
    config,
    closed,
    toolNamed: async (suffix) => {
      const names = (await client.listTools()).tools.map((t) => t.name);
      const name = names.find((n) => n.startsWith('localbox') && n.endsWith(suffix));
      if (!name) throw new Error(`no local tool ending in "${suffix}" among ${names.join(', ')}`);
      return name;
    },
    shutdown: async () => {
      await client.close().catch(() => {});
      await handle.shutdown();
    },
  };
}

const text = (result: unknown): string =>
  ((result as { content?: { type: string; text?: string }[] }).content ?? []).map((c) => c.text ?? '').join('');

/**
 * Holds every fetch whose URL ends in `suffix` until the server meets the
 * refusal: the held read is answered `response` the moment the refusal is
 * recorded, before the stop it schedules, which is the window a request in
 * flight would otherwise slip through. Resolves `held` once a read is held.
 */
function holdUntilRefusal(
  s: Awaited<ReturnType<typeof start>>,
  suffix: string,
  response: () => Response,
): { held: Promise<void> } {
  const waiting: (() => void)[] = [];
  let heldOne!: () => void;
  const held = new Promise<void>((resolve) => (heldOne = resolve));
  vi.mocked(console.error).mockImplementation((...args: unknown[]) => {
    const line = args.map(String).join(' ');
    s.stderr.push(line);
    if (line.includes('hexis-mcp has stopped serving')) waiting.splice(0).forEach((answer) => answer());
  });
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (String(input instanceof Request ? input.url : input).split('?')[0]!.endsWith(suffix) && !revoked) {
      return new Promise<Response>((resolve) => {
        waiting.push(() => resolve(response()));
        heldOne();
      });
    }
    return realFetch(input, init);
  });
  return { held };
}

/** The server stopped serving: the transport it answered on is closed. */
async function expectStopped(s: Awaited<ReturnType<typeof start>>, sentence = REVOKED_KEY_SENTENCE): Promise<void> {
  await Promise.race([
    s.closed,
    new Promise((_, reject) => setTimeout(() => reject(new Error('the server kept serving after the key was revoked')), 10_000)),
  ]);
  await expect(s.client.listTools()).rejects.toThrow();
  expect(s.rejections).toEqual([sentence]);
  expect(s.stderr.some((line) => line.includes('hexis-mcp has stopped serving'))).toBe(true);
  expect(s.stderr.join('\n')).not.toContain(KEY);
}

describe('a connection key revoked while the local server holds it', () => {
  it('runs local tools, with their vault variables, while the key is live', { timeout: 60_000 }, async () => {
    const s = await start();
    try {
      const secretTool = await s.toolNamed('secret');
      const plainTool = await s.toolNamed('plain');
      expect((await s.client.callTool({ name: secretTool, arguments: {} })).isError).not.toBe(true);
      expect((await s.client.callTool({ name: plainTool, arguments: {} })).isError).not.toBe(true);
      expect(received).toEqual([
        { tool: 'secret', secret: SECRET },
        { tool: 'plain', secret: undefined },
      ]);
      expect(s.rejections).toEqual([]);
    } finally {
      await s.shutdown();
    }
  });

  it(
    'refuses the next call of a local tool whose vault variables are cached, sends nothing, and stops serving',
    { timeout: 60_000 },
    async () => {
      const s = await start();
      try {
        const secretTool = await s.toolNamed('secret');
        // Runs once, so its variables are in the five-minute cache.
        await s.client.callTool({ name: secretTool, arguments: {} });
        expect(received).toHaveLength(1);

        revoked = true;
        await expect(s.client.callTool({ name: secretTool, arguments: {} })).rejects.toThrow(REVOKED_KEY_SENTENCE);
        expect(received).toHaveLength(1);
        await expectStopped(s);
      } finally {
        await s.shutdown();
      }
    },
  );

  it('refuses the next call of a local tool that never contacts the deployment', { timeout: 60_000 }, async () => {
    const s = await start();
    try {
      const plainTool = await s.toolNamed('plain');
      revoked = true;
      await expect(s.client.callTool({ name: plainTool, arguments: {} })).rejects.toThrow(REVOKED_KEY_SENTENCE);
      expect(received).toEqual([]);
      await expectStopped(s);
    } finally {
      await s.shutdown();
    }
  });

  it('refuses a meta-tool call', { timeout: 60_000 }, async () => {
    const s = await start();
    try {
      revoked = true;
      await expect(s.client.callTool({ name: 'list_tools', arguments: {} })).rejects.toThrow(REVOKED_KEY_SENTENCE);
      await expectStopped(s);
    } finally {
      await s.shutdown();
    }
  });

  it('refuses tools/list', { timeout: 60_000 }, async () => {
    const s = await start();
    try {
      revoked = true;
      await expect(s.client.listTools()).rejects.toThrow(REVOKED_KEY_SENTENCE);
      await expectStopped(s);
    } finally {
      await s.shutdown();
    }
  });

  it('keeps serving through a deployment that cannot be reached, which is not a revocation', { timeout: 60_000 }, async () => {
    const s = await start();
    try {
      const plainTool = await s.toolNamed('plain');
      const realFetch = globalThis.fetch;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        if (String(input instanceof Request ? input.url : input).endsWith('/api/agent/instructions')) {
          throw new TypeError('fetch failed');
        }
        return realFetch(input, init);
      });
      const result = await s.client.callTool({ name: plainTool, arguments: {} });
      expect(result.isError, text(result)).not.toBe(true);
      expect(received).toEqual([{ tool: 'plain', secret: undefined }]);
      expect(s.rejections).toEqual([]);
    } finally {
      await s.shutdown();
    }
  });

  it('goes ahead within seconds when the deployment hangs, which is unconfirmed, not revoked', { timeout: 60_000 }, async () => {
    const s = await start();
    try {
      const plainTool = await s.toolNamed('plain');
      const realFetch = globalThis.fetch;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        if (String(input instanceof Request ? input.url : input).endsWith('/api/agent/instructions')) {
          // Never answers; only the request's own timeout ends it.
          return new Promise<Response>((_, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
          });
        }
        return realFetch(input, init);
      });
      const startedAt = Date.now();
      const result = await s.client.callTool({ name: plainTool, arguments: {} });
      expect(result.isError, text(result)).not.toBe(true);
      // Well under the 15 s every other deployment read may take.
      expect(Date.now() - startedAt).toBeLessThan(8_000);
      expect(received).toEqual([{ tool: 'plain', secret: undefined }]);
      expect(s.rejections).toEqual([]);
    } finally {
      await s.shutdown();
    }
  });

  it('answers the revocation, not the discovery failure, once the key is refused', { timeout: 60_000 }, async () => {
    discoveryFails = true;
    const s = await start();
    try {
      await expect(s.client.callTool({ name: 'anything', arguments: {} })).rejects.toThrow('could not load');
      revoked = true;
      await expect(s.client.callTool({ name: 'anything', arguments: {} })).rejects.toThrow(REVOKED_KEY_SENTENCE);
      await expectStopped(s);
    } finally {
      await s.shutdown();
    }
  });

  it('runs nothing in browser sign-in mode when the deployment refuses even the renewed token', { timeout: 60_000 }, async () => {
    let renewals = 0;
    const s = await start({
      renewConnectionKey: async () => {
        renewals += 1;
        return { token: KEY };
      },
    });
    try {
      const plainTool = await s.toolNamed('plain');
      revoked = true;
      await expect(s.client.callTool({ name: plainTool, arguments: {} })).rejects.toThrow('Your sign-in was rejected');
      expect(renewals).toBeGreaterThan(0);
      expect(received).toEqual([]);
    } finally {
      await s.shutdown();
    }
  });

  it("answers a switched-off account's own sentence, not the mint-a-new-key one", { timeout: 60_000 }, async () => {
    const SWITCHED_OFF = 'Your account on this workspace is switched off. Ask its admin to turn it back on.';
    const s = await start();
    try {
      const plainTool = await s.toolNamed('plain');
      refusalSentence = SWITCHED_OFF;
      revoked = true;
      const refused = s.client.callTool({ name: plainTool, arguments: {} });
      await expect(refused).rejects.toThrow(SWITCHED_OFF);
      await expect(refused).rejects.not.toThrow('Mint a new one');
      expect(received).toEqual([]);
      await expectStopped(s, SWITCHED_OFF);
      expect(s.stderr.some((line) => line.includes('switched off') && !line.includes('Mint a new one'))).toBe(true);
    } finally {
      await s.shutdown();
    }
  });

  it('goes ahead within seconds when the renewal the confirmation needs hangs', { timeout: 60_000 }, async () => {
    let hangRenewal = false;
    const s = await start({
      renewConnectionKey: () => (hangRenewal ? new Promise<never>(() => {}) : Promise.resolve({ token: KEY })),
    });
    try {
      const plainTool = await s.toolNamed('plain');
      const realFetch = globalThis.fetch;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        if (String(input instanceof Request ? input.url : input).endsWith('/api/agent/instructions')) {
          // The token expired: the confirmation must renew, and the renewal never ends.
          return new Response(JSON.stringify({ error: 'expired' }), { status: 401 });
        }
        return realFetch(input, init);
      });
      hangRenewal = true;
      const startedAt = Date.now();
      const result = await s.client.callTool({ name: plainTool, arguments: {} });
      expect(result.isError, text(result)).not.toBe(true);
      expect(Date.now() - startedAt).toBeLessThan(8_000);
      expect(received).toEqual([{ tool: 'plain', secret: undefined }]);
    } finally {
      await s.shutdown();
    }
  });

  it('never dispatches into a re-registration that started while the key was being confirmed', { timeout: 60_000 }, async () => {
    const s = await start({ renewConnectionKey: async () => ({ token: KEY }) });
    try {
      const names = (await s.client.listTools()).tools.map((t) => t.name);
      const remote = names.find((n) => n.endsWith('list_files'));
      expect(remote, names.join(', ')).toBeDefined();
      const realFetch = globalThis.fetch;
      let confirmations = 0;
      let confirmationStarted!: () => void;
      const firstConfirmation = new Promise<void>((resolve) => (confirmationStarted = resolve));
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        if (String(input instanceof Request ? input.url : input).endsWith('/api/agent/instructions')) {
          confirmations += 1;
          confirmationStarted();
          // Slow enough that the swap below starts while this is asked.
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
        return realFetch(input, init);
      });
      const call = s.client.callTool({ name: remote!, arguments: {} });
      await firstConfirmation;
      // A credential swap lands mid-confirmation: it deregisters the remote
      // manual at once and registers it again only once the slow deployment answers.
      mcpDelayMs = 1_500;
      const swap = s.config.onConnectionKeyRenewed!(KEY);
      const result = await call;
      await swap;
      expect(result.isError, text(result)).not.toBe(true);
      expect(text(result)).toBe('listed');
      // Asked again after the swap: the dispatch rests on a confirmation with no re-registration in progress.
      expect(confirmations).toBeGreaterThanOrEqual(2);
    } finally {
      await s.shutdown();
    }
  });

  it('runs nothing for a call whose confirmation succeeded just as another request met the refusal', { timeout: 60_000 }, async () => {
    const s = await start();
    try {
      const plainTool = await s.toolNamed('plain');
      const { held } = holdUntilRefusal(
        s,
        '/api/agent/instructions',
        () => new Response(JSON.stringify({ instructions: 'Search.' }), { status: 200 }),
      );
      const inFlight = s.client.callTool({ name: plainTool, arguments: {} });
      inFlight.catch(() => {});
      await held;
      revoked = true;
      await expect(s.client.callTool({ name: plainTool, arguments: {} })).rejects.toThrow(REVOKED_KEY_SENTENCE);
      await expect(inFlight).rejects.toThrow(REVOKED_KEY_SENTENCE);
      expect(received).toEqual([]);
    } finally {
      await s.shutdown();
    }
  });

  it('lists nothing for a listing still reading its hints when another request met the refusal', { timeout: 60_000 }, async () => {
    advertiseHints = true;
    const s = await start();
    try {
      const { held } = holdUntilRefusal(
        s,
        '/api/agent/tool-hints',
        () => new Response(JSON.stringify({ hints: {} }), { status: 200 }),
      );
      const listing = s.client.listTools();
      listing.catch(() => {});
      await held;
      revoked = true;
      await expect(s.client.callTool({ name: 'list_tools', arguments: {} })).rejects.toThrow(REVOKED_KEY_SENTENCE);
      await expect(listing).rejects.toThrow(REVOKED_KEY_SENTENCE);
    } finally {
      await s.shutdown();
    }
  });

  it('hands a second shutdown caller the teardown already in progress', { timeout: 60_000 }, async () => {
    const release = holdDiscovery();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // Discovery is held mid-download, so teardown waits on it (up to its grace).
    const handle = await createHexisMcpServer({ baseUrl: base, connectionKey: KEY }, '0.0.0', { catalogCheck: false });
    try {
      const first = handle.shutdown();
      const second = handle.shutdown();
      expect(second).toBe(first);
      let secondSettled = false;
      void second.then(() => (secondSettled = true));
      await new Promise((resolve) => setTimeout(resolve, 300));
      // The teardown is still held open, and the second caller is still waiting for it.
      expect(secondSettled).toBe(false);
      release();
      await second;
      expect(secondSettled).toBe(true);
    } finally {
      release();
      await handle.shutdown();
    }
  });
});
