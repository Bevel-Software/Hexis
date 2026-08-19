import { describe, expect, it, vi } from 'vitest';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { createMcpAuthMiddleware } from '../mcp-auth.middleware.js';
import type { AuthService } from '../../auth/auth.service.js';
import type { IExternalApiKeyService } from '../../tool-auth/external-api-key.interface.js';
import type { BevelOAuthProvider } from '../oauth/bevel-oauth-provider.js';
import { InternalTokenService } from '../../tool-auth/internal-token.service.js';

const RESOURCE_METADATA_URL = 'https://bevel.example/.well-known/oauth-protected-resource/api/mcp';

function makeReqRes(authorization?: string) {
  const req: any = { headers: authorization ? { authorization } : {} };
  const setHeader = vi.fn();
  const status = vi.fn().mockReturnThis();
  const json = vi.fn().mockReturnThis();
  const res: any = { setHeader, status, json };
  const next = vi.fn();
  return { req, res, next, setHeader, status, json };
}

function makeAuthService(verify?: (t: string) => { userId: string; email: string }) {
  return {
    verifyToken: vi.fn(verify ?? (() => {
      throw new Error('invalid');
    })),
  } as unknown as AuthService;
}

function makeExternalApiKeyService(
  resolve?: (
    t: string,
  ) => Promise<{
    tokenId: string;
    user: { id: string; email: string; name: string; avatarUrl?: string };
  } | null>,
) {
  return {
    looksLikeExternalApiKey: (t: string) => typeof t === 'string' && t.startsWith('bevel_'),
    // The bevel_ path resolves the token *id* alongside the user so the tool
    // handler can meter per-key usage against the daily cap.
    verifyAndLoadToken: vi.fn(resolve ?? (async () => null)),
    verifyAndLoadUser: vi.fn(),
    mint: vi.fn(),
    listForUser: vi.fn(),
    revoke: vi.fn(),
  } as unknown as IExternalApiKeyService;
}

function makeOAuthProvider(
  verify?: (t: string) => Promise<{ extra?: Record<string, unknown> }>,
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

function makeMw(
  overrides: {
    auth?: AuthService;
    keys?: IExternalApiKeyService;
    oauth?: BevelOAuthProvider;
    internal?: InternalTokenService;
  } = {},
) {
  return createMcpAuthMiddleware(
    overrides.auth ?? makeAuthService(),
    overrides.keys ?? makeExternalApiKeyService(),
    overrides.oauth ?? makeOAuthProvider(),
    RESOURCE_METADATA_URL,
    overrides.internal ?? new InternalTokenService({ secret: 'test-secret-32-bytes-long-enough!!' }),
  );
}

describe('createMcpAuthMiddleware', () => {
  it('401s with a resource_metadata WWW-Authenticate challenge when the Authorization header is missing', async () => {
    const mw = makeMw();
    const { req, res, next, setHeader, status } = makeReqRes();

    await mw(req, res, next);

    // RFC 9728: the challenge must point OAuth-capable clients at the
    // protected-resource metadata so they can discover the AS.
    expect(setHeader).toHaveBeenCalledWith(
      'WWW-Authenticate',
      expect.stringContaining(`resource_metadata="${RESOURCE_METADATA_URL}"`),
    );
    expect(status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('accepts a lowercase "bearer " scheme per RFC 7235 (case-insensitive match)', async () => {
    const externalApiKeys = makeExternalApiKeyService(async () => ({
      tokenId: 'tok-9',
      user: { id: 'user-9', email: 'c@example.com', name: 'Carol' },
    }));
    const mw = makeMw({ keys: externalApiKeys });
    const { req, res, next } = makeReqRes('bearer bevel_abc');

    await mw(req, res, next);

    expect(req.userId).toBe('user-9');
    expect(next).toHaveBeenCalled();
    // Token extraction must not silently include the scheme prefix.
    expect((externalApiKeys as any).verifyAndLoadToken).toHaveBeenCalledWith('bevel_abc');
  });

  it('401s on a non-Bearer scheme', async () => {
    const mw = makeMw();
    const { req, res, next, status } = makeReqRes('Basic abc:123');

    await mw(req, res, next);

    expect(status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('resolves a bevel_ connection key via ExternalApiKeyService and attaches userId/email/externalApiKeyId', async () => {
    const externalApiKeys = makeExternalApiKeyService(async () => ({
      tokenId: 'tok-7',
      user: { id: 'user-7', email: 'alice@example.com', name: 'Alice' },
    }));
    const auth = makeAuthService();
    const mw = makeMw({ auth, keys: externalApiKeys });
    const { req, res, next } = makeReqRes('Bearer bevel_abc');

    await mw(req, res, next);

    expect(req.userId).toBe('user-7');
    expect(req.userEmail).toBe('alice@example.com');
    expect(req.externalApiKeyId).toBe('tok-7');
    expect(next).toHaveBeenCalled();
    // JWT path must NOT be touched for a bevel_ token — otherwise a leaked
    // key would also get a JWT-verify error logged.
    expect((auth as any).verifyToken).not.toHaveBeenCalled();
  });

  it('401s with WWW-Authenticate when a bevel_ token is unknown or revoked', async () => {
    const mw = makeMw({ keys: makeExternalApiKeyService(async () => null) });
    const { req, res, next, setHeader, status, json } = makeReqRes('Bearer bevel_revoked');

    await mw(req, res, next);

    expect(setHeader).toHaveBeenCalledWith(
      'WWW-Authenticate',
      expect.stringContaining('Bearer'),
    );
    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringMatching(/connection key/i) }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('500s — not 401s — when the token service throws (DB outage etc.)', async () => {
    const externalApiKeys = makeExternalApiKeyService(async () => {
      throw new Error('db down');
    });
    const mw = makeMw({ keys: externalApiKeys });
    const { req, res, next, status } = makeReqRes('Bearer bevel_abc');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    await mw(req, res, next);

    expect(status).toHaveBeenCalledWith(500);
    expect(next).not.toHaveBeenCalled();
    err.mockRestore();
  });

  it('resolves an OAuth access token via the provider and attaches userId/email WITHOUT externalApiKeyId', async () => {
    const auth = makeAuthService();
    const externalApiKeys = makeExternalApiKeyService();
    const oauth = makeOAuthProvider(async () => ({
      extra: { userId: 'user-5', userEmail: 'eve@example.com' },
    }));
    const mw = makeMw({ auth, keys: externalApiKeys, oauth });
    const { req, res, next } = makeReqRes('Bearer bevel-mcp_token123');

    await mw(req, res, next);

    expect(req.userId).toBe('user-5');
    expect(req.userEmail).toBe('eve@example.com');
    // OAuth sessions are unmetered like JWT sessions — no connection key id.
    expect(req.externalApiKeyId).toBeUndefined();
    expect(next).toHaveBeenCalled();
    // Neither the connection-key nor the JWT path may see this token shape.
    expect((externalApiKeys as any).verifyAndLoadToken).not.toHaveBeenCalled();
    expect((auth as any).verifyToken).not.toHaveBeenCalled();
  });

  it('401s with the discovery challenge when the OAuth token is invalid/expired/revoked', async () => {
    const mw = makeMw();
    const { req, res, next, setHeader, status } = makeReqRes('Bearer bevel-mcp_expired');

    await mw(req, res, next);

    expect(setHeader).toHaveBeenCalledWith(
      'WWW-Authenticate',
      expect.stringContaining('resource_metadata='),
    );
    expect(status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('500s — not 401s — when OAuth verification fails on a backend error', async () => {
    const oauth = makeOAuthProvider(async () => {
      throw new Error('db down');
    });
    const mw = makeMw({ oauth });
    const { req, res, next, status } = makeReqRes('Bearer bevel-mcp_token');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    await mw(req, res, next);

    expect(status).toHaveBeenCalledWith(500);
    expect(next).not.toHaveBeenCalled();
    err.mockRestore();
  });

  it('falls through to JWT verification when the token is not a connection key or OAuth token', async () => {
    const auth = makeAuthService(() => ({ userId: 'user-3', email: 'bob@example.com' }));
    const externalApiKeys = makeExternalApiKeyService();
    const mw = makeMw({ auth, keys: externalApiKeys });
    const { req, res, next } = makeReqRes('Bearer eyJhbGciOiJIUzI1NiJ9.xyz');

    await mw(req, res, next);

    expect(req.userId).toBe('user-3');
    expect(req.userEmail).toBe('bob@example.com');
    expect(next).toHaveBeenCalled();
    // Make sure we didn't try the external-api-key path for a JWT.
    expect((externalApiKeys as any).verifyAndLoadToken).not.toHaveBeenCalled();
  });

  it('401s when JWT verification fails', async () => {
    const auth = makeAuthService(() => {
      throw new Error('expired');
    });
    const mw = makeMw({ auth });
    const { req, res, next, status } = makeReqRes('Bearer not.a.real.jwt');

    await mw(req, res, next);

    expect(status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });


  /**
   * The internal-token branch: server-minted only (createSession's loopback
   * bearer, the /mcp/local-token exchange). hexis-mcp's OAuth mode sends one
   * here when it registers this endpoint as its remote manual — the exact hop
   * that failed while this surface refused the shape.
   */
  describe('internal tokens', () => {
    const internal = new InternalTokenService({ secret: 'test-secret-32-bytes-long-enough!!' });

    it('accepts a live internal token and resolves the user', async () => {
      const token = internal.mint({ userId: 'user-7', externalProxy: true }, 60_000);
      const auth = makeAuthService();
      (auth.getUserById as ReturnType<typeof vi.fn>) = vi.fn(async () => ({
        id: 'user-7',
        email: 'seven@example.com',
      }));
      const mw = makeMw({ internal, auth });
      const { req, res, next } = makeReqRes(`Bearer ${token}`);
      await mw(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(req.userId).toBe('user-7');
      expect(req.userEmail).toBe('seven@example.com');
    });

    it('401s an expired internal token', async () => {
      const past = new InternalTokenService({
        secret: 'test-secret-32-bytes-long-enough!!',
        now: () => Date.now() - 120_000,
      });
      const token = past.mint({ userId: 'user-7', externalProxy: true }, 60_000);
      const mw = makeMw({ internal });
      const { req, res, next, status } = makeReqRes(`Bearer ${token}`);
      await mw(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(status).toHaveBeenCalledWith(401);
    });

    it('401s an internal token whose user no longer exists', async () => {
      const token = internal.mint({ userId: 'ghost', externalProxy: true }, 60_000);
      const auth = makeAuthService();
      (auth.getUserById as ReturnType<typeof vi.fn>) = vi.fn(async () => null);
      const mw = makeMw({ internal, auth });
      const { req, res, next, status } = makeReqRes(`Bearer ${token}`);
      await mw(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(status).toHaveBeenCalledWith(401);
    });
  });
});
