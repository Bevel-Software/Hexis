import { describe, expect, it } from 'vitest';
import {
  InternalTokenService,
  deriveInternalTokenSecret,
} from '../internal-token.service.js';
import { createTokenVerifier } from '../tool-auth.middleware.js';
import type { IExternalApiKeyService } from '../external-api-key.interface.js';

const claim = { userId: 'user-A' };

describe('InternalTokenService', () => {
  it('mints a token that verifies back to the same claim', () => {
    const svc = new InternalTokenService({ secret: 'test-secret' });
    const token = svc.mint(claim);
    expect(svc.looksLikeInternalToken(token)).toBe(true);
    expect(svc.verify(token)).toEqual(claim);
  });

  it('round-trips the externalProxy flag (the MCP proxy loopback identity)', () => {
    const svc = new InternalTokenService({ secret: 'test-secret' });
    const token = svc.mint({ userId: 'user-A', externalProxy: true });
    expect(svc.verify(token)).toEqual({ userId: 'user-A', externalProxy: true });
  });

  it('rejects a tampered token', () => {
    const svc = new InternalTokenService({ secret: 'test-secret' });
    const token = svc.mint(claim);
    expect(svc.verify(token + 'x')).toBeNull();
    expect(svc.verify(token.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a')))).toBeNull();
  });

  it('rejects a token signed with a different secret', () => {
    const a = new InternalTokenService({ secret: 'secret-a' });
    const b = new InternalTokenService({ secret: 'secret-b' });
    expect(b.verify(a.mint(claim))).toBeNull();
  });

  it('rejects an expired token', () => {
    let now = 1_000_000;
    const svc = new InternalTokenService({ secret: 's', ttlMs: 1000, now: () => now });
    const token = svc.mint(claim);
    now += 1500;
    expect(svc.verify(token)).toBeNull();
  });

  it('verifies a token minted by a SIBLING instance sharing the secret (CLI → server)', () => {
    // The routine CLI and a second replica each build their own service graph;
    // with the same configured secret their tokens must verify across
    // instances — this is what makes the loopback tool surface reachable from
    // a process other than the server itself.
    const secret = deriveInternalTokenSecret('deployment-jwt-secret');
    const cliSide = new InternalTokenService({ secret });
    const serverSide = new InternalTokenService({ secret });
    expect(serverSide.verify(cliSide.mint(claim))).toEqual(claim);
  });

  it('derives a stable, domain-separated internal secret from the JWT secret', () => {
    const derived = deriveInternalTokenSecret('deployment-jwt-secret');
    // Deterministic (same input → same key) …
    expect(deriveInternalTokenSecret('deployment-jwt-secret')).toBe(derived);
    // … but never the JWT secret itself, and different per input.
    expect(derived).not.toBe('deployment-jwt-secret');
    expect(deriveInternalTokenSecret('other-secret')).not.toBe(derived);
    expect(derived).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects a connection-key-shaped bearer', () => {
    const svc = new InternalTokenService({ secret: 's' });
    expect(svc.verify('bevel_abc123')).toBeNull();
    expect(svc.looksLikeInternalToken('bevel_abc123')).toBe(false);
  });
});

describe('createTokenVerifier — internal-token source resolution', () => {
  const noExternalKeys = {
    looksLikeExternalApiKey: () => false,
    verifyAndLoadToken: async () => null,
  } as unknown as IExternalApiKeyService;

  it('a plain per-run internal token resolves to source internal with its sessionId', async () => {
    const svc = new InternalTokenService({ secret: 's' });
    const verify = createTokenVerifier(noExternalKeys, svc);
    const result = await verify(svc.mint({ userId: 'user-A', sessionId: 'run-1' }));
    expect(result).toEqual({
      ok: true,
      auth: { source: 'internal', userId: 'user-A', sessionId: 'run-1', scope: 'write' },
    });
  });

  it('an externalProxy token resolves to source EXTERNAL — the caller is an external agent', async () => {
    // The MCP proxy mints this as the loopback identity of an OAuth/JWT MCP
    // session. Resolving it internal used to deadlock those sessions: the
    // external-only `start_session` refused them, and every session-gated
    // tool demands the sessionId they then couldn't mint.
    const svc = new InternalTokenService({ secret: 's' });
    const verify = createTokenVerifier(noExternalKeys, svc);
    const result = await verify(svc.mint({ userId: 'user-A', externalProxy: true }));
    expect(result).toEqual({
      ok: true,
      auth: { source: 'external', userId: 'user-A', scope: 'write' },
    });
  });
});
