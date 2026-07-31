import { describe, expect, it, vi } from 'vitest';
import { McpOAuthDiscoveryService } from '../mcp-oauth-discovery.service.js';
import type { ISecretsVaultService, OAuthProviderConfig } from '../secrets-vault.contract.js';

const MCP_URL = 'https://mcp.example.com/mcp';
const REDIRECT_URI = 'https://bevel.example.com/api/secrets/oauth/callback';

const PRM_URL = 'https://mcp.example.com/.well-known/oauth-protected-resource/mcp';
const AS_META_URL = 'https://auth.example.com/.well-known/oauth-authorization-server';

const PRM = {
  resource: MCP_URL,
  authorization_servers: ['https://auth.example.com'],
  scopes_supported: ['mcp.read'],
};
const AS_META = {
  issuer: 'https://auth.example.com',
  authorization_endpoint: 'https://auth.example.com/authorize',
  token_endpoint: 'https://auth.example.com/token',
  registration_endpoint: 'https://auth.example.com/register',
};

function json(body: unknown, status = 200, headers?: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

/** Route-table fetch: each URL maps to a responder; unrouted URLs 404. */
function makeFetch(routes: Record<string, (init?: RequestInit) => Response>) {
  const calls: string[] = [];
  const fetchFn = (async (url: unknown, init?: RequestInit) => {
    const key = String(url);
    calls.push(key);
    const handler = routes[key];
    return handler ? handler(init) : new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { fetchFn, calls };
}

function makeVault(existing: OAuthProviderConfig | null = null) {
  return {
    getSharedOAuthProvider: vi.fn(async () => existing),
    putSharedOAuthProvider: vi.fn(async () => {}),
  } as unknown as ISecretsVaultService & {
    getSharedOAuthProvider: ReturnType<typeof vi.fn>;
    putSharedOAuthProvider: ReturnType<typeof vi.fn>;
  };
}

function makeService(
  vault: ReturnType<typeof makeVault>,
  fetchFn: typeof fetch,
  now?: () => number,
) {
  return new McpOAuthDiscoveryService({ secretsVault: vault, redirectUri: REDIRECT_URI, fetchFn, now });
}

describe('McpOAuthDiscoveryService', () => {
  it('reports open when the server answers the probe without a 401', async () => {
    const vault = makeVault();
    const { fetchFn } = makeFetch({ [MCP_URL]: () => json({ ok: true }) });
    const res = await makeService(vault, fetchFn).statusFor('notion', MCP_URL);
    expect(res).toEqual({ status: 'open' });
    expect(vault.putSharedOAuthProvider).not.toHaveBeenCalled();
  });

  it('treats a 200 initialize as needing auth when the server publishes PRM (Google gmail/calendar)', async () => {
    // Google's MCP servers answer an unauthenticated `initialize` with 200 but
    // still require OAuth for tool calls, advertised via the well-known PRM doc.
    const vault = makeVault();
    const { fetchFn } = makeFetch({
      [MCP_URL]: () => json({ ok: true }), // 200, no WWW-Authenticate
      [PRM_URL]: () => json(PRM), // path-aware well-known PRM exists
      [AS_META_URL]: () => json(AS_META),
      ['https://auth.example.com/register']: () => json({ client_id: 'dcr-g' }, 201),
    });
    const res = await makeService(vault, fetchFn).statusFor('gmail', MCP_URL);
    expect(res.status).toBe('oauth');
    expect(vault.putSharedOAuthProvider).toHaveBeenCalled();
  });

  it('walks 401 → resource metadata → AS metadata → DCR and persists a public PKCE client', async () => {
    const vault = makeVault();
    let registration: Record<string, unknown> | null = null;
    const { fetchFn } = makeFetch({
      [MCP_URL]: () =>
        json({ error: 'unauthorized' }, 401, {
          'WWW-Authenticate': `Bearer resource_metadata="${PRM_URL}"`,
        }),
      [PRM_URL]: () => json(PRM),
      [AS_META_URL]: () => json(AS_META),
      ['https://auth.example.com/register']: (init) => {
        registration = JSON.parse(String(init?.body));
        return json({ client_id: 'dcr-client-1' }, 201);
      },
    });

    const res = await makeService(vault, fetchFn).statusFor('notion', MCP_URL);

    expect(res.status).toBe('oauth');
    if (res.status !== 'oauth') return;
    expect(res.provider).toMatchObject({
      authorizationUrl: 'https://auth.example.com/authorize',
      tokenUrl: 'https://auth.example.com/token',
      clientId: 'dcr-client-1',
      pkce: true,
      publicClient: true,
      resource: MCP_URL,
      scopes: ['mcp.read'],
    });
    // Registered as a PUBLIC client against OUR callback.
    expect(registration).toMatchObject({
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
    });
    // Persisted under the synthetic key so the standard tool-OAuth flow can run.
    expect(vault.putSharedOAuthProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'notion_MCP_OAUTH',
        provider: expect.objectContaining({ clientId: 'dcr-client-1', pkce: true }),
      }),
    );
  });

  it('falls back to the well-known PRM path when the 401 carries no resource_metadata', async () => {
    const vault = makeVault();
    const { fetchFn } = makeFetch({
      [MCP_URL]: () => json({}, 401),
      [PRM_URL]: () => json(PRM), // path-aware well-known location
      [AS_META_URL]: () => json(AS_META),
      ['https://auth.example.com/register']: () => json({ client_id: 'dcr-client-2' }, 201),
    });
    const res = await makeService(vault, fetchFn).statusFor('notion', MCP_URL);
    expect(res.status).toBe('oauth');
  });

  it('reports unsupported when the AS offers no dynamic client registration', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const vault = makeVault();
    const { fetchFn } = makeFetch({
      [MCP_URL]: () => json({}, 401),
      [PRM_URL]: () => json(PRM),
      [AS_META_URL]: () => json({ ...AS_META, registration_endpoint: undefined }),
    });
    const res = await makeService(vault, fetchFn).statusFor('notion', MCP_URL);
    expect(res.status).toBe('unsupported');
    expect(vault.putSharedOAuthProvider).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('short-circuits on an already-persisted registration — never re-registers a client', async () => {
    const existing: OAuthProviderConfig = {
      authorizationUrl: 'https://auth.example.com/authorize',
      tokenUrl: 'https://auth.example.com/token',
      clientId: 'previously-registered',
      pkce: true,
      publicClient: true,
    };
    const vault = makeVault(existing);
    const { fetchFn, calls } = makeFetch({});
    const res = await makeService(vault, fetchFn).statusFor('notion', MCP_URL);
    expect(res).toEqual({ status: 'oauth', provider: existing });
    expect(calls).toEqual([]); // no network at all
  });

  it('caches results — a second lookup makes no further requests', async () => {
    const vault = makeVault();
    const { fetchFn, calls } = makeFetch({ [MCP_URL]: () => json({ ok: true }) });
    const svc = makeService(vault, fetchFn);
    await svc.statusFor('notion', MCP_URL);
    const afterFirst = calls.length;
    await svc.statusFor('notion', MCP_URL);
    expect(calls.length).toBe(afterFirst);
  });
});
