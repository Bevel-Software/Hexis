import { afterEach, describe, expect, it, vi } from 'vitest';
import { InternalTokenService } from '../../tool-auth/internal-token.service.js';
import { createTokenVerifier } from '../../tool-auth/tool-auth.middleware.js';
import type { IExternalApiKeyService } from '../../tool-auth/external-api-key.interface.js';
import type { BevelOAuthProvider } from '../oauth/bevel-oauth-provider.js';
import { NOT_AN_AGENT_CHOICE } from '../oauth/oauth-consent.routes.js';
import { agentFile, agentScopeOver, inMemoryKb } from '../../agent-scope/__tests__/in-memory-kb.js';
import { closeMountedRoutes, mountMcpRoutes } from './mcp-routes-harness.js';

/**
 * Connecting as an agent on the MCP router: the key-mint path takes the same
 * "Connect as" choice the consent step does, the dialog is told the same
 * agents, the local server's exchanged grant carries the connection's agent,
 * and every MCP request hands the proxy the agent its credential connects as.
 */

const ADA = 'ada@example.com';
const kb = inMemoryKb({
  'Agents/ops.agent': agentFile('name: ops\ndescription: Watches the dashboards.'),
  'Agents/secret.agent': agentFile('name: secret'),
});
kb.hidden.add('Agents/secret.agent');

afterEach(async () => {
  await closeMountedRoutes();
  vi.restoreAllMocks();
});

function keyService() {
  const mint = vi.fn(async (_userId: string, label: string, options?: { agentPath?: string }) => ({
    plaintext: 'bevel_new',
    summary: { id: 'k1', label, agentPath: options?.agentPath ?? null },
  }));
  return {
    service: { looksLikeExternalApiKey: (t: string) => t.startsWith('bevel_'), mint } as unknown as IExternalApiKeyService,
    mint,
  };
}

const post = (url: string, body: unknown) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-email': ADA },
    body: JSON.stringify(body),
  });

describe('minting a connection key', () => {
  it('as Everything: no choice is minted exactly as before', async () => {
    const { service, mint } = keyService();
    const base = await mountMcpRoutes({ externalApiKeyService: service, agents: agentScopeOver(kb) });
    const res = await post(`${base}/api/mcp/external-api-keys`, { label: 'laptop' });
    expect(res.status).toBe(200);
    expect(mint).toHaveBeenCalledWith('user-A', 'laptop', {});
  });

  it('as an agent on offer: the key records its normalized path', async () => {
    const { service, mint } = keyService();
    const base = await mountMcpRoutes({ externalApiKeyService: service, agents: agentScopeOver(kb) });
    const res = await post(`${base}/api/mcp/external-api-keys`, { label: 'pipeline', agentPath: 'Agents/ops.agent/' });
    expect(res.status).toBe(200);
    expect(mint).toHaveBeenCalledWith('user-A', 'pipeline', { agentPath: 'Agents/ops.agent' });
    expect(((await res.json()) as { summary: { agentPath: string } }).summary.agentPath).toBe('Agents/ops.agent');
  });

  it.each([['Agents/secret.agent'], ['Agents/none.agent'], [7]])('refuses %s, minting nothing', async (agentPath) => {
    const { service, mint } = keyService();
    const base = await mountMcpRoutes({ externalApiKeyService: service, agents: agentScopeOver(kb) });
    const res = await post(`${base}/api/mcp/external-api-keys`, { label: 'x', agentPath });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: NOT_AN_AGENT_CHOICE });
    expect(mint).not.toHaveBeenCalled();
  });

  it('offers the same agents the consent step does', async () => {
    const base = await mountMcpRoutes({ agents: agentScopeOver(kb) });
    const res = await fetch(`${base}/api/mcp/agent-choices`, { headers: { 'x-test-email': ADA } });
    expect(await res.json()).toEqual({
      agents: [{ path: 'Agents/ops.agent', name: 'ops', description: 'Watches the dashboards.' }],
    });
  });
});

describe('the local server’s exchanged grant', () => {
  it("carries the connection's agent, so its calls narrow exactly as the hosted endpoint's", async () => {
    const internalTokens = new InternalTokenService({ secret: 'test-secret' });
    const oauth = {
      looksLikeAccessToken: (t: string) => t.startsWith('bevel-mcp_'),
      verifyAccessToken: async () => ({
        extra: { userId: 'user-5', userEmail: ADA, connectionId: 'conn-9', agentPath: 'Agents/ops.agent' },
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      }),
    } as unknown as BevelOAuthProvider;
    const base = await mountMcpRoutes({
      externalApiKeyService: { looksLikeExternalApiKey: () => false } as never,
      internalTokens,
      oauthProvider: oauth,
    });
    const res = await fetch(`${base}/api/mcp/local-token`, {
      method: 'POST',
      headers: { Authorization: 'Bearer bevel-mcp_grant' },
    });
    const { token } = (await res.json()) as { token: string };
    const verify = createTokenVerifier({ looksLikeExternalApiKey: () => false } as never, internalTokens);
    expect(await verify(token)).toEqual({
      ok: true,
      auth: { source: 'external', userId: 'user-5', connectionId: 'conn-9', agentPath: 'Agents/ops.agent', scope: 'write' },
    });
  });

  it('an Everything grant mints the token it always did', async () => {
    const internalTokens = new InternalTokenService({ secret: 'test-secret' });
    const oauth = {
      looksLikeAccessToken: (t: string) => t.startsWith('bevel-mcp_'),
      verifyAccessToken: async () => ({
        extra: { userId: 'user-5', userEmail: ADA, connectionId: 'conn-9', agentPath: null },
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      }),
    } as unknown as BevelOAuthProvider;
    const base = await mountMcpRoutes({
      externalApiKeyService: { looksLikeExternalApiKey: () => false } as never,
      internalTokens,
      oauthProvider: oauth,
    });
    const res = await fetch(`${base}/api/mcp/local-token`, { method: 'POST', headers: { Authorization: 'Bearer bevel-mcp_g' } });
    const { token } = (await res.json()) as { token: string };
    expect(internalTokens.verify(token)).toEqual({ userId: 'user-5', externalProxy: true, connectionId: 'conn-9' });
  });

  it("a direct tool call reads the connection's CURRENT choice: a re-consent reaches a token minted before it", async () => {
    const internalTokens = new InternalTokenService({ secret: 'test-secret' });
    const keys = { looksLikeExternalApiKey: () => false } as never;
    let current: { agentPath: string | null } | null = { agentPath: 'Agents/ops.agent' };
    const verify = createTokenVerifier(keys, internalTokens, undefined, {
      liveConnectionChoice: async (id) => (id === 'conn-9' ? current : null),
    });
    // Minted as Everything, served as the agent chosen since.
    const everything = internalTokens.mint({ userId: 'user-5', externalProxy: true, connectionId: 'conn-9' }, 60_000);
    expect(await verify(everything)).toEqual({
      ok: true,
      auth: { source: 'external', userId: 'user-5', connectionId: 'conn-9', agentPath: 'Agents/ops.agent', scope: 'write' },
    });
    // Minted as an agent, served as Everything once the person chose it.
    current = { agentPath: null };
    const asAgent = internalTokens.mint(
      { userId: 'user-5', externalProxy: true, connectionId: 'conn-9', agentPath: 'Agents/ops.agent' },
      60_000,
    );
    expect(await verify(asAgent)).toEqual({
      ok: true,
      auth: { source: 'external', userId: 'user-5', connectionId: 'conn-9', scope: 'write' },
    });
  });

  it("refuses a direct tool call through a revoked connection's token, whatever the token says it connects as", async () => {
    const internalTokens = new InternalTokenService({ secret: 'test-secret' });
    const keys = { looksLikeExternalApiKey: () => false } as never;
    const verify = createTokenVerifier(keys, internalTokens, undefined, { liveConnectionChoice: async () => null });
    const token = internalTokens.mint(
      { userId: 'user-5', externalProxy: true, connectionId: 'conn-9', agentPath: 'Agents/ops.agent' },
      60_000,
    );
    expect(await verify(token)).toEqual({ ok: false, status: 401, message: 'Access for this agent was revoked' });
  });
});

describe('an MCP request', () => {
  it("hands the proxy the agent its credential connects as — and nothing for Everything", async () => {
    const createRequestServer = vi.fn(async () => {
      throw new Error('stop here');
    });
    const base = await mountMcpRoutes({ mcpService: { createRequestServer } });
    const call = (headers: Record<string, string>) =>
      fetch(`${base}/api/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
    await call({ 'x-test-agent-path': 'Agents/ops.agent' });
    await call({});
    const callers = createRequestServer.mock.calls.map((c) => (c as unknown[])[0] as Record<string, unknown>);
    expect(callers[0]).toMatchObject({ userId: 'user-A', agentPath: 'Agents/ops.agent' });
    expect(callers[1]).not.toHaveProperty('agentPath');
  });
});
