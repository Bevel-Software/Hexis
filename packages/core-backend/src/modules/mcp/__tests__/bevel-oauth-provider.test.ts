import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { InvalidGrantError, InvalidScopeError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { BevelOAuthProvider } from '../oauth/bevel-oauth-provider.js';
import { signAuthRequest, verifyAuthRequest } from '../oauth/oauth-state.js';
import type { Database } from '../../database/connection.js';

const STATE_SECRET = 'test-state-secret';
const PREFIX = 'bevel-mcp_';
const FRONTEND = 'https://app.example.com';

/** Same fake drizzle chain as external-api-key.service.test.ts: every
 * chainable method returns the chain, the chain is thenable, and each
 * db.insert/select/update pops the next queued result. */
function makeFakeDb(queue: any[]) {
  const captured: { values: any[]; set: any[] } = { values: [], set: [] };

  function nextChain() {
    const result = queue.shift();
    const chain: any = {};
    const passthrough = (recorder?: (args: any[]) => void) =>
      vi.fn((...args: any[]) => {
        recorder?.(args);
        return chain;
      });
    chain.values = passthrough((a) => captured.values.push(a[0]));
    chain.set = passthrough((a) => captured.set.push(a[0]));
    chain.where = passthrough();
    chain.limit = passthrough();
    chain.innerJoin = passthrough();
    chain.from = passthrough();
    chain.returning = passthrough();
    chain.then = (onF: any, onR: any) => Promise.resolve(result).then(onF, onR);
    return chain;
  }

  const db = {
    insert: vi.fn(() => nextChain()),
    select: vi.fn(() => nextChain()),
    update: vi.fn(() => nextChain()),
  } as unknown as Database;

  return { db, captured };
}

function makeProvider(queue: any[] = []) {
  const { db, captured } = makeFakeDb(queue);
  const provider = new BevelOAuthProvider({
    db,
    crypto: null,
    stateSecret: STATE_SECRET,
    publicFrontendUrl: FRONTEND,
    tokenPrefix: PREFIX,
  });
  return { provider, captured, db };
}

const CLIENT: OAuthClientInformationFull = {
  client_id: 'client-1',
  redirect_uris: ['https://agent.example.com/callback'],
  token_endpoint_auth_method: 'none',
};

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

describe('oauth-state', () => {
  it('round-trips a signed authorization request', () => {
    const token = signAuthRequest(STATE_SECRET, {
      c: 'client-1',
      r: 'https://agent.example.com/callback',
      cc: 'challenge',
      s: 'client-state',
      sc: 'mcp',
    });
    const parsed = verifyAuthRequest(STATE_SECRET, token);
    expect(parsed).toMatchObject({ c: 'client-1', cc: 'challenge', s: 'client-state' });
  });

  it('rejects a tampered or wrong-secret state', () => {
    const token = signAuthRequest(STATE_SECRET, { c: 'c', r: 'https://x', cc: 'ch' });
    expect(verifyAuthRequest('other-secret', token)).toBeNull();
    expect(verifyAuthRequest(STATE_SECRET, `${token}x`)).toBeNull();
    expect(verifyAuthRequest(STATE_SECRET, 'garbage')).toBeNull();
  });

  it('rejects an expired state', () => {
    vi.useFakeTimers();
    try {
      const token = signAuthRequest(STATE_SECRET, { c: 'c', r: 'https://x', cc: 'ch' });
      vi.advanceTimersByTime(31 * 60_000); // past the 30-min max age
      expect(verifyAuthRequest(STATE_SECRET, token)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('BevelOAuthProvider', () => {
  it('routes bearers by prefix (access tokens yes, connection keys / JWTs no)', () => {
    const { provider } = makeProvider();
    expect(provider.looksLikeAccessToken('bevel-mcp_abc')).toBe(true);
    expect(provider.looksLikeAccessToken('bevel_abc')).toBe(false);
    expect(provider.looksLikeAccessToken('eyJhbGciOiJIUzI1NiJ9.x.y')).toBe(false);
  });

  it('authorize signs the request into state and redirects to /connect', async () => {
    const { provider } = makeProvider();
    const redirect = vi.fn();
    const res: any = { redirect };

    await provider.authorize(
      CLIENT,
      {
        codeChallenge: 'the-challenge',
        redirectUri: 'https://agent.example.com/callback',
        state: 'client-state',
        scopes: ['mcp'],
      },
      res,
    );

    expect(redirect).toHaveBeenCalledWith(302, expect.stringContaining(`${FRONTEND}/connect?oauth=`));
    const url = new URL(redirect.mock.calls[0][1]);
    const st = verifyAuthRequest(STATE_SECRET, url.searchParams.get('oauth') ?? '');
    // The state must pin exactly what the SDK validated — the Finish endpoint
    // binds the auth code to these values.
    expect(st).toMatchObject({
      c: 'client-1',
      r: 'https://agent.example.com/callback',
      cc: 'the-challenge',
      s: 'client-state',
      sc: 'mcp',
    });
  });

  it('issueAuthCode stores the code hashed and returns the client redirect with code + state', async () => {
    const { provider, captured } = makeProvider([undefined /* insert */]);
    const st = { c: 'client-1', r: 'https://agent.example.com/callback', cc: 'ch', s: 'cs', iat: Date.now() };

    const { redirectTo } = await provider.issueAuthCode('user-1', st);

    const url = new URL(redirectTo);
    const code = url.searchParams.get('code')!;
    expect(code.startsWith(PREFIX)).toBe(true);
    expect(url.searchParams.get('state')).toBe('cs');
    expect(url.origin + url.pathname).toBe('https://agent.example.com/callback');
    // Hashed at rest, bound to the user + request.
    expect(captured.values[0]).toMatchObject({
      codeHash: sha256(code),
      clientId: 'client-1',
      userId: 'user-1',
      codeChallenge: 'ch',
    });
  });

  it('challengeForAuthorizationCode returns the stored challenge and rejects foreign/consumed/expired codes', async () => {
    const future = new Date(Date.now() + 60_000);
    const row = (over: object) => ({
      codeHash: 'h', clientId: 'client-1', userId: 'u', redirectUri: 'r',
      codeChallenge: 'the-challenge', consumedAt: null, expiresAt: future, ...over,
    });

    await expect(
      makeProvider([[row({})]]).provider.challengeForAuthorizationCode(CLIENT, 'code'),
    ).resolves.toBe('the-challenge');
    await expect(
      makeProvider([[]]).provider.challengeForAuthorizationCode(CLIENT, 'unknown'),
    ).rejects.toBeInstanceOf(InvalidGrantError);
    await expect(
      makeProvider([[row({ clientId: 'other' })]]).provider.challengeForAuthorizationCode(CLIENT, 'code'),
    ).rejects.toBeInstanceOf(InvalidGrantError);
    await expect(
      makeProvider([[row({ consumedAt: new Date() })]]).provider.challengeForAuthorizationCode(CLIENT, 'code'),
    ).rejects.toBeInstanceOf(InvalidGrantError);
    await expect(
      makeProvider([[row({ expiresAt: new Date(Date.now() - 1000) })]]).provider.challengeForAuthorizationCode(CLIENT, 'code'),
    ).rejects.toBeInstanceOf(InvalidGrantError);
  });

  it('exchangeAuthorizationCode consumes the code and mints a hashed token pair', async () => {
    const consumed = {
      clientId: 'client-1', userId: 'user-1', redirectUri: 'https://agent.example.com/callback',
      scope: 'mcp', resource: null,
    };
    const { provider, captured } = makeProvider([[consumed] /* update.returning */, undefined /* insert */]);

    const tokens = await provider.exchangeAuthorizationCode(
      CLIENT, 'the-code', undefined, 'https://agent.example.com/callback',
    );

    expect(tokens.token_type).toBe('Bearer');
    expect(tokens.access_token.startsWith(PREFIX)).toBe(true);
    expect(tokens.refresh_token!.startsWith(`${PREFIX}r_`)).toBe(true);
    expect(tokens.expires_in).toBe(3600);
    expect(tokens.scope).toBe('mcp');
    // The token row stores hashes of exactly what was returned.
    expect(captured.values[0]).toMatchObject({
      accessTokenHash: sha256(tokens.access_token),
      refreshTokenHash: sha256(tokens.refresh_token!),
      clientId: 'client-1',
      userId: 'user-1',
    });
  });

  it('exchangeAuthorizationCode rejects a spent/unknown code and a redirect_uri mismatch', async () => {
    await expect(
      makeProvider([[]]).provider.exchangeAuthorizationCode(CLIENT, 'spent'),
    ).rejects.toBeInstanceOf(InvalidGrantError);

    const consumed = { clientId: 'client-1', userId: 'u', redirectUri: 'https://agent.example.com/callback', scope: null, resource: null };
    await expect(
      makeProvider([[consumed]]).provider.exchangeAuthorizationCode(CLIENT, 'code', undefined, 'https://evil.example.com/cb'),
    ).rejects.toBeInstanceOf(InvalidGrantError);
  });

  it('exchangeRefreshToken rotates (revokes old row, mints new pair) and only narrows scope', async () => {
    const oldRow = {
      clientId: 'client-1', userId: 'user-1', scope: 'mcp extra', resource: null,
      refreshExpiresAt: new Date(Date.now() + 60_000),
    };
    const { provider } = makeProvider([[oldRow] /* revoke.returning */, undefined /* insert */]);
    const tokens = await provider.exchangeRefreshToken(CLIENT, 'bevel-mcp_r_old', ['mcp']);
    expect(tokens.scope).toBe('mcp');

    // Widening is refused.
    await expect(
      makeProvider([[oldRow]]).provider.exchangeRefreshToken(CLIENT, 'bevel-mcp_r_old', ['mcp', 'admin']),
    ).rejects.toBeInstanceOf(InvalidScopeError);

    // Unknown/already-rotated refresh token.
    await expect(
      makeProvider([[]]).provider.exchangeRefreshToken(CLIENT, 'bevel-mcp_r_gone'),
    ).rejects.toBeInstanceOf(InvalidGrantError);
  });

  it('verifyAccessToken resolves a live token to AuthInfo carrying the Bevel user', async () => {
    const row = {
      id: 'tok-row-1', clientId: 'client-1', scope: 'mcp', resource: null,
      expiresAt: new Date(Date.now() + 60_000), userId: 'user-1', userEmail: 'alice@example.com',
    };
    const { provider } = makeProvider([[row] /* select */, undefined /* lastUsedAt touch */]);

    const info = await provider.verifyAccessToken('bevel-mcp_live');

    expect(info.clientId).toBe('client-1');
    expect(info.scopes).toEqual(['mcp']);
    expect(info.extra).toMatchObject({ userId: 'user-1', userEmail: 'alice@example.com' });
  });

  it('verifyAccessToken throws InvalidTokenError for unknown/revoked/expired tokens', async () => {
    // The WHERE already filters revoked/expired, so any miss surfaces the same way.
    await expect(
      makeProvider([[]]).provider.verifyAccessToken('bevel-mcp_dead'),
    ).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it('revokeByAccessToken revokes our own bearers and no-ops on foreign shapes', async () => {
    const { provider, db } = makeProvider([undefined /* revoke update */]);
    await provider.revokeByAccessToken('bevel-mcp_live');
    expect((db as any).update).toHaveBeenCalledTimes(1);

    const foreign = makeProvider([]);
    await foreign.provider.revokeByAccessToken('bevel_connectionkey'); // connection key
    await foreign.provider.revokeByAccessToken('eyJhbGciOiJIUzI1NiJ9.x.y'); // JWT
    expect((foreign.db as any).update).not.toHaveBeenCalled();
  });

  it('registerClient refuses a confidential client when no encryption key is configured', async () => {
    const { provider } = makeProvider();
    await expect(
      provider.clientsStore.registerClient!({
        ...CLIENT,
        token_endpoint_auth_method: 'client_secret_post',
        client_secret: 'shhh',
      } as any),
    ).rejects.toThrow(/encryption key/i);
  });

  it('registerClient stores a public client and never persists a plaintext secret in metadata', async () => {
    const { provider, captured } = makeProvider([undefined /* insert */]);
    const returned = await provider.clientsStore.registerClient!({ ...CLIENT } as any);
    expect(returned).toMatchObject({ client_id: 'client-1' });
    expect(captured.values[0].clientSecretEncrypted).toBeNull();
    expect(JSON.stringify(captured.values[0].metadata)).not.toContain('client_secret');
  });
});
