import { describe, expect, it } from 'vitest';
import { InternalTokenService } from '../internal-token.service.js';
import { createTokenVerifier, externalCallerAuth } from '../tool-auth.middleware.js';
import type { IExternalApiKeyService } from '../external-api-key.interface.js';
import type { AuthService } from '../../auth/auth.service.js';

/**
 * `externalCallerAuth` describes the caller the hosted MCP endpoint reads
 * skills as, when it calls the skill reads as functions. Over loopback the
 * endpoint sent a bearer and the verifier resolved it. The two must name the
 * same caller, so each case here resolves the bearer the endpoint would have
 * sent and compares.
 */
const AGENT = 'Agents/narrow.agent';
const KEYS: Record<string, { user: { id: string }; tokenId: string; agentPath?: string }> = {
  bevel_plain: { user: { id: 'ada' }, tokenId: 'tok-plain' },
  bevel_as_agent: { user: { id: 'ada' }, tokenId: 'tok-agent', agentPath: AGENT },
};

const keys = {
  looksLikeExternalApiKey: (t: string) => t.startsWith('bevel_'),
  verifyAndLoadToken: async (t: string) => KEYS[t] ?? null,
} as unknown as IExternalApiKeyService;
const accounts = { isActive: async () => true } as unknown as AuthService;
const internalTokens = new InternalTokenService({ secret: 'test-secret' });
const verify = createTokenVerifier(keys, internalTokens, accounts);

const resolved = async (bearer: string) => {
  const result = await verify(bearer);
  expect(result.ok).toBe(true);
  return result.ok ? result.auth : undefined;
};

describe('externalCallerAuth', () => {
  it('names a connection key\'s caller as the verifier resolves the key', async () => {
    expect(externalCallerAuth({ userId: 'ada', tokenId: 'tok-plain', agentPath: null })).toEqual(await resolved('bevel_plain'));
  });

  it('names a key made as an agent with that agent', async () => {
    expect(externalCallerAuth({ userId: 'ada', tokenId: 'tok-agent', agentPath: AGENT })).toEqual(
      await resolved('bevel_as_agent'),
    );
  });

  // A caller with no key (OAuth, or a session): the endpoint minted an
  // `externalProxy` token for the person and the agent of their connection.
  it('names a caller with no key as the verifier resolves the token the endpoint minted for them', async () => {
    const plain = internalTokens.mint({ userId: 'ada', externalProxy: true });
    expect(externalCallerAuth({ userId: 'ada', tokenId: null, agentPath: null })).toEqual(await resolved(plain));

    const asAgent = internalTokens.mint({ userId: 'ada', externalProxy: true, agentPath: AGENT });
    expect(externalCallerAuth({ userId: 'ada', tokenId: null, agentPath: AGENT })).toEqual(await resolved(asAgent));
  });

  it('is an external caller at write scope, never the in-process agent', () => {
    expect(externalCallerAuth({ userId: 'ada', tokenId: null, agentPath: null })).toEqual({
      source: 'external',
      userId: 'ada',
      scope: 'write',
    });
  });
});
