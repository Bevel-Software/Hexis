import type { Server as HttpServer } from 'node:http';
import type { RequestHandler } from 'express';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { createMcpRoutes } from '../mcp.routes.js';
import { MCP_LOOPBACK_TOKEN_TTL_MS } from '../mcp.service.js';
import { InternalTokenService } from '../../tool-auth/internal-token.service.js';
import { createTokenVerifier } from '../../tool-auth/tool-auth.middleware.js';
import type { IExternalApiKeyService } from '../../tool-auth/external-api-key.interface.js';
import type { BevelOAuthProvider } from '../oauth/bevel-oauth-provider.js';

/**
 * Coverage for POST /api/mcp/local-token — the OAuth-access-token → internal
 * loopback-token exchange the LOCAL MCP server uses to reach the
 * keys+internal-tokens-only `/api/agent/*` surface. Locks down:
 *
 *   - a verified OAuth token mints an internal token that the tool-auth
 *     verifier resolves to the SAME identity createSession's loopback bearer
 *     gets (right userId, externalProxy → source 'external'), with the shared
 *     MCP_LOOPBACK_TOKEN_TTL_MS lifetime;
 *   - an expired/revoked OAuth token re-challenges (401 + resource_metadata),
 *     mirroring McpAuthMiddleware's OAuth branch;
 *   - every other credential shape (connection key, JWT) is 403 — those need
 *     no exchange, so accepting them would mint a second credential from a
 *     first;
 *   - missing/garbage auth is 401 with the discovery challenge.
 */

const RESOURCE_METADATA_URL = 'https://bevel.example/.well-known/oauth-protected-resource/api/mcp';

// Stand-in for routes this suite never exercises.
const fakeAuth: RequestHandler = (req, _res, next) => {
  req.userId = 'user-A';
  next();
};

let httpServer: HttpServer | undefined;

afterEach(async () => {
  if (httpServer) {
    await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
    httpServer = undefined;
  }
  vi.restoreAllMocks();
});

function makeOAuthProvider(
  verify?: (t: string) => Promise<{ extra?: Record<string, unknown>; expiresAt?: number }>,
) {
  return {
    looksLikeAccessToken: (t: string) => typeof t === 'string' && t.startsWith('bevel-mcp_'),
    verifyAccessToken: vi.fn(
      verify ??
        (async () => {
          throw new InvalidTokenError('unknown token');
        }),
    ),
  } as unknown as BevelOAuthProvider;
}

async function mount(oauth: BevelOAuthProvider): Promise<{
  baseUrl: string;
  internalTokens: InternalTokenService;
}> {
  const internalTokens = new InternalTokenService({ secret: 'test-secret' });
  const externalApiKeyService = {
    looksLikeExternalApiKey: (t: string) => typeof t === 'string' && t.startsWith('bevel_'),
  } as unknown as IExternalApiKeyService;
  // createMcpRoutes only touches mcpService.onSessionEvicted at construction.
  const mcpService = { onSessionEvicted: () => {} } as never;
  const stub = {} as never;

  const app = express();
  app.use(express.json());
  app.use(
    '/api',
    createMcpRoutes(
      mcpService,
      externalApiKeyService,
      fakeAuth,
      fakeAuth,
      stub,
      internalTokens,
      oauth,
      RESOURCE_METADATA_URL,
    ),
  );

  httpServer = await new Promise<HttpServer>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = (httpServer.address() as { port: number }).port;
  return { baseUrl: `http://127.0.0.1:${port}`, internalTokens };
}

async function exchange(baseUrl: string, authorization?: string): Promise<Response> {
  return fetch(`${baseUrl}/api/mcp/local-token`, {
    method: 'POST',
    headers: authorization ? { Authorization: authorization } : {},
  });
}

describe('POST /mcp/local-token', () => {
  it('exchanges a valid OAuth access token for an internal token with the loopback identity + TTL', async () => {
    const oauth = makeOAuthProvider(async () => ({
      extra: { userId: 'user-5', userEmail: 'eve@example.com' },
      // A grant with plenty of life left: the loopback constant is the binding cap.
      expiresAt: Math.floor(Date.now() / 1000) + 24 * 60 * 60,
    }));
    const { baseUrl, internalTokens } = await mount(oauth);

    const res = await exchange(baseUrl, 'Bearer bevel-mcp_valid123');

    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; expiresInMs: number };
    // Same TTL constant createSession's loopback bearer uses — the grant
    // above outlives it, so the constant is the cap that binds.
    expect(body.expiresInMs).toBe(MCP_LOOPBACK_TOKEN_TTL_MS);
    // The minted token verifies to the resolved user with the externalProxy
    // flag — identical shape to the hosted session's loopback bearer.
    expect(internalTokens.verify(body.token)).toEqual({ userId: 'user-5', externalProxy: true });
    // …and the tool-auth verifier resolves it to source 'external', exactly
    // how /api/agent/* will treat the local server.
    const verify = createTokenVerifier(
      { looksLikeExternalApiKey: () => false } as unknown as IExternalApiKeyService,
      internalTokens,
    );
    await expect(verify(body.token)).resolves.toEqual({
      ok: true,
      auth: { source: 'external', userId: 'user-5', scope: 'write' },
    });
    expect((oauth as any).verifyAccessToken).toHaveBeenCalledWith('bevel-mcp_valid123');
  });

  /**
   * The binding that keeps the exchange from OUTLIVING its grant: an access
   * token with less life left than the loopback constant caps the minted
   * token's TTL at that remainder — otherwise a nearly-expired OAuth grant
   * would buy five more hours of internal-token access.
   */
  it('caps expiresInMs at the access token\'s remaining lifetime when that is shorter', async () => {
    const remainingSeconds = 90;
    const oauth = makeOAuthProvider(async () => ({
      extra: { userId: 'user-5' },
      expiresAt: Math.floor(Date.now() / 1000) + remainingSeconds,
    }));
    const { baseUrl, internalTokens } = await mount(oauth);

    const res = await exchange(baseUrl, 'Bearer bevel-mcp_shortlived');

    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; expiresInMs: number };
    // The returned number is the ACTUAL lifetime: at most the remainder,
    // and nowhere near the 5h constant. (A tolerance below, for the
    // seconds-granularity of expiresAt and the time the request takes.)
    expect(body.expiresInMs).toBeLessThanOrEqual(remainingSeconds * 1000);
    expect(body.expiresInMs).toBeGreaterThan((remainingSeconds - 10) * 1000);
    expect(internalTokens.verify(body.token)).toEqual({ userId: 'user-5', externalProxy: true });
  });

  /**
   * A provider that reports no expiry (the AuthInfo field is optional) falls
   * back to the constant alone — absence must not read as "expires now".
   */
  it('falls back to the loopback constant when the provider reports no expiresAt', async () => {
    const oauth = makeOAuthProvider(async () => ({
      extra: { userId: 'user-5' },
    }));
    const { baseUrl } = await mount(oauth);

    const res = await exchange(baseUrl, 'Bearer bevel-mcp_noexpiry');

    expect(res.status).toBe(200);
    const body = (await res.json()) as { expiresInMs: number };
    expect(body.expiresInMs).toBe(MCP_LOOPBACK_TOKEN_TTL_MS);
  });

  it('401s with the resource_metadata challenge on an expired/revoked OAuth token', async () => {
    const { baseUrl } = await mount(makeOAuthProvider()); // default verify throws InvalidTokenError

    const res = await exchange(baseUrl, 'Bearer bevel-mcp_expired');

    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain(
      `resource_metadata="${RESOURCE_METADATA_URL}"`,
    );
    await expect(res.json()).resolves.toEqual(
      expect.objectContaining({ error: expect.stringMatching(/invalid|expired|revoked/i) }),
    );
  });

  it('500s — not 401s — when OAuth verification fails on a backend error', async () => {
    const { baseUrl } = await mount(
      makeOAuthProvider(async () => {
        throw new Error('db down');
      }),
    );
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await exchange(baseUrl, 'Bearer bevel-mcp_token');

    expect(res.status).toBe(500);
    err.mockRestore();
  });

  it('403s a connection key — a key holder needs no exchange', async () => {
    const { baseUrl } = await mount(makeOAuthProvider());

    const res = await exchange(baseUrl, 'Bearer bevel_connectionkey');

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual(
      expect.objectContaining({ error: expect.stringMatching(/OAuth access tokens only/i) }),
    );
  });

  it('403s a JWT', async () => {
    const { baseUrl } = await mount(makeOAuthProvider());

    const res = await exchange(baseUrl, 'Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig');

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual(
      expect.objectContaining({ error: expect.stringMatching(/OAuth access tokens only/i) }),
    );
  });

  it('403s an internal token — it IS the exchange output, never its input', async () => {
    const { baseUrl, internalTokens } = await mount(makeOAuthProvider());

    const res = await exchange(baseUrl, `Bearer ${internalTokens.mint({ userId: 'user-A' })}`);

    expect(res.status).toBe(403);
  });

  it('401s with the challenge when the Authorization header is missing', async () => {
    const { baseUrl } = await mount(makeOAuthProvider());

    const res = await exchange(baseUrl);

    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('resource_metadata=');
  });

  it('401s with the challenge on a garbage bearer token', async () => {
    const { baseUrl } = await mount(makeOAuthProvider());

    const res = await exchange(baseUrl, 'Bearer total-garbage');

    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('resource_metadata=');
  });

  it('401s on a non-Bearer scheme', async () => {
    const { baseUrl } = await mount(makeOAuthProvider());

    const res = await exchange(baseUrl, 'Basic abc:123');

    expect(res.status).toBe(401);
  });
});
