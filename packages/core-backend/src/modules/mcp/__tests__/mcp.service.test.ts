import type { Server as HttpServer } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpService } from '../mcp.service.js';
import { McpSessionStore } from '../mcp-session-store.js';
import { SpillStore } from '../../workspace/spill-store.js';
import { createManualRoutes } from '../../tool-registry/manual.routes.js';
import { ToolRegistry } from '../../tool-registry/tool-registry.js';
import { toolDef } from '../../tool-helpers/tool-def.js';

/**
 * End-to-end proxy test: a real express app serving the registry-driven tool
 * surface over loopback, a real per-session `UtcpClient` discovering it, and a
 * real MCP `Client` driving the proxy over an in-memory transport. Exercises
 * discovery, prefix stripping, schema/args passthrough, dispatch, result
 * mapping, and error translation — without any UTCP/MCP fakes.
 */

let httpServer: HttpServer | undefined;
const cleanups: Array<() => Promise<void>> = [];

// Module-hosted tool endpoints + their registered defs: a stand-in echo `ask`
// (mirrors the real `{text, sessionId}` contract) and an erroring `boom`.
async function setup(deps?: {
  secretsVault?: unknown;
  toolManuals?: unknown;
  /** Session auth kind: a connection-key id (default), or null for an OAuth/JWT session. */
  tokenId?: string | null;
  /** Spy for the session-grant reset fired on broken sign-ins. */
  revokeOAuthAccess?: (bearer: string) => Promise<void>;
}) {
  const registry = new ToolRegistry();
  registry.registerExternalTool(
    toolDef({
      name: 'ask',
      description: 'echo the prompt',
      path: '/api/agent/tools/ask',
      inputs: {
        type: 'object',
        properties: { prompt: { type: 'string' }, sessionId: { type: 'string' } },
        required: ['prompt'],
      },
    }),
  );
  registry.registerExternalTool(
    toolDef({ name: 'boom', description: 'always errors', path: '/api/agent/tools/boom', inputs: { type: 'object', properties: {} } }),
  );
  // A tool whose input schema uses $defs/$ref — the shape Google's gmail/calendar
  // MCP servers emit. It must survive the whole pipe (discover → flatten → list)
  // and be accepted by a real MCP client, with the refs inlined out.
  registry.registerExternalTool(
    toolDef({
      name: 'refy',
      description: 'has $defs/$ref in its schema',
      path: '/api/agent/tools/refy',
      inputs: {
        type: 'object',
        $defs: { Recipient: { type: 'object', properties: { email: { type: 'string' } }, required: ['email'] } },
        properties: { to: { type: 'array', items: { $ref: '#/$defs/Recipient' } } },
        required: ['to'],
      } as never,
    }),
  );

  const app = express();
  app.use(express.json());
  const noAuth: express.RequestHandler = (_req, _res, next) => next();
  app.post('/api/agent/tools/ask', (req, res) => {
    const b = (req.body ?? {}) as { prompt?: string; sessionId?: string };
    res.json({ text: `echo: ${b.prompt}`, sessionId: typeof b.sessionId === 'string' ? b.sessionId : 'new-sess' });
  });
  app.post('/api/agent/tools/boom', (_req, res) => res.status(500).json({ error: 'kaboom' }));
  app.use('/api', createManualRoutes(registry, noAuth));
  httpServer = await new Promise<HttpServer>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = (httpServer.address() as { port: number }).port;

  const mcp = new McpService(
    new McpSessionStore(),
    {
      loopbackBaseUrl: `http://127.0.0.1:${port}`,
      manualName: 'KNOWLEDGE_BASE',
      spillStore: new SpillStore(join(tmpdir(), 'bevel-test-spills')),
      publicFrontendUrl: 'http://localhost:5173',
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    deps?.secretsVault as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    deps?.toolManuals as any,
    undefined, // internalTokens — the fake loopback here accepts any bearer
    deps?.revokeOAuthAccess,
  );
  const tokenId = deps?.tokenId === undefined ? 'tok-1' : deps.tokenId;
  const { server } = await mcp.createSession('user-A', tokenId, 'bevel_testkey', () => {});

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities: {} });
  await client.connect(clientTransport);

  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c().catch(() => {});
  if (httpServer) await new Promise<void>((r) => httpServer!.close(() => r()));
  httpServer = undefined;
});

describe('McpService (UTCP→MCP proxy)', () => {
  it('lists the discovered tools with clean (prefix-stripped) schemas, envelope intact', async () => {
    const client = await setup();
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

    // The direct tools, plus the always-present code-mode meta-tools.
    expect(Object.keys(byName).sort()).toEqual(['ask', 'boom', 'call_tool_chain', 'list_tools', 'refy', 'tools_info']);
    // The manual's schema passes through verbatim: KB tools advertise the same
    // {body} envelope UTCP dispatches on (and that call_tool_chain documents).
    const askSchema = byName.ask.inputSchema as { properties: { body?: { properties?: Record<string, unknown> } } };
    expect(askSchema.properties.body?.properties?.prompt).toBeDefined();
  });

  it('a $defs/$ref tool schema survives tools/list and a real MCP client accepts it', async () => {
    // No tokenId filter for this assertion — an OAuth-style session lists all.
    const client = await setup({ tokenId: null });
    const { tools } = await client.listTools(); // throws if the SDK client rejects the payload
    const refy = tools.find((t) => t.name === 'refy')!;
    expect(refy).toBeDefined();
    // Whatever became of the refs, none may leak to the client — an Anthropic-
    // backed client rejects the ENTIRE tools/list over one $ref/$defs.
    const schema = JSON.stringify(refy.inputSchema);
    expect(schema).not.toContain('$ref');
    expect(schema).not.toContain('$defs');
  });

  it('list_tools returns the discovered tools in TS-accessible form', async () => {
    const client = await setup();
    const res = await client.callTool({ name: 'list_tools', arguments: {} });
    const parsed = JSON.parse((res.content as Array<{ text: string }>)[0].text);
    expect(parsed.tools).toContain('KNOWLEDGE_BASE.ask');
    expect(parsed.tools).toContain('KNOWLEDGE_BASE.boom');
  });

  it('call_tool_chain runs TS that invokes a real tool over loopback', async () => {
    const client = await setup();
    const res = await client.callTool({
      name: 'call_tool_chain',
      arguments: { code: "return KNOWLEDGE_BASE.ask({ body: { prompt: 'hi' } });" },
    });
    const parsed = JSON.parse((res.content as Array<{ text: string }>)[0].text);
    expect(parsed.success).toBe(true);
    // The chain executed in the isolated-vm, called the ask endpoint over
    // loopback with the caller's key, and returned its echo result.
    expect(parsed.result).toMatchObject({ text: 'echo: hi' });
  });

  it('dispatches a tool call back through the REST endpoint and returns its result text', async () => {
    const client = await setup();
    const res = await client.callTool({ name: 'ask', arguments: { body: { prompt: 'hello' } } });
    // The whole structured result is stringified, so both the answer text and the
    // sessionId a client must echo back to poll survive (no collapsing to `text`).
    const payload = JSON.parse((res.content as Array<{ text: string }>)[0].text);
    expect(payload.text).toBe('echo: hello');
    expect(payload.sessionId).toBe('new-sess');
    expect(res.isError).toBeFalsy();
  });

  it('translates a downstream tool failure into an MCP isError result', async () => {
    const client = await setup();
    const res = await client.callTool({ name: 'boom', arguments: {} });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0].text).toMatch(/boom/i);
  });

  it('returns an isError result for an unknown tool', async () => {
    const client = await setup();
    const res = await client.callTool({ name: 'ghost', arguments: {} });
    expect(res.isError).toBe(true);
  });
});

describe('McpService — per-user credential pre-check', () => {
  // The discovered `ask`/`boom` tools live under the `KNOWLEDGE_BASE` manual, so
  // these stubs answer as if that manual declared a per-user variable.
  const vault = (userConfigured: boolean, userAuthorized?: boolean, grantedScopes?: string) => ({
    statusFor: async (_userId: string, keys: string[]) =>
      keys.map((key) => ({ key, adminConfigured: false, userConfigured, userAuthorized, grantedScopes })),
  });
  const manualsWithUserVar = {
    userScopedKeysForManual: async (manual: string) =>
      manual === 'KNOWLEDGE_BASE'
        ? [{ key: 'KNOWLEDGE_BASE_API_KEY', name: 'API_KEY', label: 'Your API key', oauth: false }]
        : [],
  };
  const manualsWithOAuthVar = {
    userScopedKeysForManual: async (manual: string) =>
      manual === 'KNOWLEDGE_BASE'
        ? [{ key: 'KNOWLEDGE_BASE_GOOGLE', name: 'GOOGLE', label: 'Google', oauth: true }]
        : [],
  };
  // An OAuth var that requires two scopes — for the scope-coverage cases.
  const manualsWithScopedOAuthVar = {
    userScopedKeysForManual: async (manual: string) =>
      manual === 'KNOWLEDGE_BASE'
        ? [
            {
              key: 'KNOWLEDGE_BASE_GOOGLE',
              name: 'GOOGLE',
              label: 'Google',
              oauth: true,
              oauthScopes: ['openid', 'https://www.googleapis.com/auth/calendar.readonly'],
            },
          ]
        : [],
  };
  const manualsNoUserVar = {
    userScopedKeysForManual: async () =>
      [] as { key: string; name: string; label: string | null; oauth: boolean }[],
  };

  it('gates a tool whose personal credential is unset — returns the setup link, not the tool', async () => {
    const client = await setup({ secretsVault: vault(false), toolManuals: manualsWithUserVar });
    const res = await client.callTool({ name: 'ask', arguments: { body: { prompt: 'hello' } } });
    expect(res.isError).toBe(true);
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toMatch(/ask/); // names the tool
    expect(text).toMatch(/Your API key/); // names the missing item by label
    expect(text).toContain('http://localhost:5173/connect'); // the setup link
    // Crucially, it did NOT run the tool (no echo payload).
    expect(text).not.toMatch(/echo:/);
  });

  it('lets the tool run once every personal credential is set', async () => {
    const client = await setup({ secretsVault: vault(true), toolManuals: manualsWithUserVar });
    const res = await client.callTool({ name: 'ask', arguments: { body: { prompt: 'hello' } } });
    expect(res.isError).toBeFalsy();
    const payload = JSON.parse((res.content as Array<{ text: string }>)[0].text);
    expect(payload.text).toBe('echo: hello');
  });

  it('never gates a tool whose manual declares no personal credential', async () => {
    const client = await setup({ secretsVault: vault(false), toolManuals: manualsNoUserVar });
    const res = await client.callTool({ name: 'ask', arguments: { body: { prompt: 'hi' } } });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse((res.content as Array<{ text: string }>)[0].text).text).toBe('echo: hi');
  });

  it('skips the check entirely when the vault/manual services are not wired', async () => {
    const client = await setup(); // no deps → check is a no-op
    const res = await client.callTool({ name: 'ask', arguments: { body: { prompt: 'hi' } } });
    expect(res.isError).toBeFalsy();
  });

  it('gates an OAuth var whose row exists but is NOT yet authorized', async () => {
    // Row present (userConfigured) but no token yet (userAuthorized:false) → needs auth.
    const client = await setup({
      secretsVault: vault(true, false),
      toolManuals: manualsWithOAuthVar,
    });
    const res = await client.callTool({ name: 'ask', arguments: { body: { prompt: 'hi' } } });
    expect(res.isError).toBe(true);
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toMatch(/Google/);
    expect(text).toContain('/connect');
    expect(text).not.toMatch(/echo:/);
  });

  it('lets the tool run once the OAuth var is authorized', async () => {
    const client = await setup({
      secretsVault: vault(true, true),
      toolManuals: manualsWithOAuthVar,
    });
    const res = await client.callTool({ name: 'ask', arguments: { body: { prompt: 'hi' } } });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse((res.content as Array<{ text: string }>)[0].text).text).toBe('echo: hi');
  });

  it('gates an authorized OAuth var whose token is missing a now-required scope', async () => {
    // Authorized, but the token was granted only `openid` while the tool now
    // requires `calendar.readonly` too → route to re-auth instead of a provider 400.
    const client = await setup({
      secretsVault: vault(true, true, 'openid'),
      toolManuals: manualsWithScopedOAuthVar,
    });
    const res = await client.callTool({ name: 'ask', arguments: { body: { prompt: 'hi' } } });
    expect(res.isError).toBe(true);
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toMatch(/Google/);
    expect(text).toContain('/connect');
    expect(text).not.toMatch(/echo:/);
  });

  it('lets the tool run when the token covers every now-required scope', async () => {
    const client = await setup({
      secretsVault: vault(true, true, 'openid https://www.googleapis.com/auth/calendar.readonly'),
      toolManuals: manualsWithScopedOAuthVar,
    });
    const res = await client.callTool({ name: 'ask', arguments: { body: { prompt: 'hi' } } });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse((res.content as Array<{ text: string }>)[0].text).text).toBe('echo: hi');
  });

  it('gates an authorized OAuth var whose token has no recorded granted scopes', async () => {
    // A token minted before granted scopes were captured (grantedScopes undefined)
    // cannot prove it covers the required scopes → fail safe to re-auth.
    const client = await setup({
      secretsVault: vault(true, true, undefined),
      toolManuals: manualsWithScopedOAuthVar,
    });
    const res = await client.callTool({ name: 'ask', arguments: { body: { prompt: 'hi' } } });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0].text).toContain('/connect');
  });

  // A sign-in that EXISTS but is broken resets an interactive session's own
  // grant, so the MCP client re-runs the browser authorization and lands the
  // user on /connect. Never-configured tools and connection-key sessions must
  // NOT trigger it.
  describe('session-grant reset (re-auth trigger)', () => {
    const revokeSpy = () => {
      const calls: string[] = [];
      return { calls, fn: async (bearer: string) => void calls.push(bearer) };
    };

    it('revokes the session grant when an EXISTING sign-in is broken (OAuth session)', async () => {
      const revoke = revokeSpy();
      // Row exists (userConfigured) but sign-in never completed / grant dead.
      const client = await setup({
        secretsVault: vault(true, false),
        toolManuals: manualsWithOAuthVar,
        tokenId: null,
        revokeOAuthAccess: revoke.fn,
      });
      const res = await client.callTool({ name: 'ask', arguments: { body: { prompt: 'hi' } } });
      expect(res.isError).toBe(true);
      expect(revoke.calls).toEqual(['bevel_testkey']); // the session's bearer
    });

    it('also triggers for an authorized-but-under-scoped sign-in', async () => {
      const revoke = revokeSpy();
      const client = await setup({
        secretsVault: vault(true, true, 'openid'),
        toolManuals: manualsWithScopedOAuthVar,
        tokenId: null,
        revokeOAuthAccess: revoke.fn,
      });
      await client.callTool({ name: 'ask', arguments: { body: { prompt: 'hi' } } });
      expect(revoke.calls.length).toBe(1);
    });

    it('does NOT trigger for a never-configured sign-in (no row) — just the /connect link', async () => {
      const revoke = revokeSpy();
      const client = await setup({
        secretsVault: vault(false),
        toolManuals: manualsWithOAuthVar,
        tokenId: null,
        revokeOAuthAccess: revoke.fn,
      });
      const res = await client.callTool({ name: 'ask', arguments: { body: { prompt: 'hi' } } });
      expect(res.isError).toBe(true);
      expect(revoke.calls).toEqual([]);
    });

    it('does NOT trigger on a connection-key session (no grant to reset)', async () => {
      const revoke = revokeSpy();
      const client = await setup({
        secretsVault: vault(true, false),
        toolManuals: manualsWithOAuthVar,
        tokenId: 'tok-1',
        revokeOAuthAccess: revoke.fn,
      });
      await client.callTool({ name: 'ask', arguments: { body: { prompt: 'hi' } } });
      expect(revoke.calls).toEqual([]);
    });
  });

  // Connection-key sessions are autonomous pipelines: a tool whose personal
  // credentials aren't satisfied is not REGISTERED at all (absent from
  // tools/list), instead of failing mid-run at call time.
  describe('listing-time filter (connection-key sessions only)', () => {
    const toolNames = async (client: Awaited<ReturnType<typeof setup>>) =>
      (await client.listTools()).tools.map((t) => t.name).sort();

    it('hides a tool with an unset personal credential from a connection-key session', async () => {
      const client = await setup({ secretsVault: vault(false), toolManuals: manualsWithUserVar });
      // The KNOWLEDGE_BASE tools are gone; the meta-tools always remain.
      expect(await toolNames(client)).toEqual(['call_tool_chain', 'list_tools', 'tools_info']);
    });

    it('lists the tool once the personal credential is set', async () => {
      const client = await setup({ secretsVault: vault(true), toolManuals: manualsWithUserVar });
      expect(await toolNames(client)).toEqual(['ask', 'boom', 'call_tool_chain', 'list_tools', 'refy', 'tools_info']);
    });

    it('keeps the full listing for an OAuth/JWT session (tokenId null) — the caller configures interactively', async () => {
      const client = await setup({
        secretsVault: vault(false),
        toolManuals: manualsWithUserVar,
        tokenId: null,
      });
      expect(await toolNames(client)).toEqual(['ask', 'boom', 'call_tool_chain', 'list_tools', 'refy', 'tools_info']);
    });
  });
});
