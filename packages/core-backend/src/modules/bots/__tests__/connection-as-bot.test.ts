import { describe, expect, it, vi } from 'vitest';
import { createTokenVerifier } from '../../tool-auth/tool-auth.middleware.js';
import { InternalTokenService } from '../../tool-auth/internal-token.service.js';
import type { IExternalApiKeyService } from '../../tool-auth/external-api-key.interface.js';
import type { ConnectionChoice, Principal, ResolvedConnection } from '../index.js';

/**
 * The credential verifier every agent surface runs: whom each call of a
 * connection acts as. A connection made as a bot acts as the bot's row, with
 * the person kept as `madeBy`; the bots mechanism is asked on EVERY call, so
 * a bot that stops being usable, or a person who may no longer act as it,
 * stops the next call; and the connection then loads nothing — the person's
 * identity is never handed its access.
 */

const DANA: Principal = { id: 'u-dana', email: 'dana@acme.com' };
const OPS: Principal = { id: 'u-ops', email: 'ops@agent.hexis' };

const keys = {
  looksLikeExternalApiKey: (t: string) => t.startsWith('bevel_'),
  verifyAndLoadToken: async (t: string) =>
    t === 'bevel_myself'
      ? { tokenId: 'k1', user: { ...DANA, name: 'Dana' }, botUserId: null, agentPath: null }
      : t === 'bevel_bot'
        ? { tokenId: 'k2', user: { ...DANA, name: 'Dana' }, botUserId: OPS.id, agentPath: null }
        : t === 'bevel_legacy'
          ? { tokenId: 'k3', user: { ...DANA, name: 'Dana' }, botUserId: null, agentPath: 'Agents/ops.agent' }
          : null,
} as unknown as IExternalApiKeyService;

function botsAnswering(answer: () => ResolvedConnection) {
  return { resolveConnection: vi.fn<(maker: Principal, choice: ConnectionChoice) => Promise<ResolvedConnection>>(async () => answer()) };
}

const asOps = (maker: Principal): ResolvedConnection => ({
  kind: 'bot',
  actor: OPS,
  madeBy: maker,
  bot: { id: 'ops', name: 'ops' },
  platformTools: null,
});

describe('a connection made as a bot, at the credential verifier', () => {
  const internal = new InternalTokenService({ secret: 'test-secret' });

  it('Myself: the person, unchanged, without asking the bots anything', async () => {
    const bots = botsAnswering(() => asOps(DANA));
    const verify = createTokenVerifier(keys, internal, undefined, undefined, { bots, userOf: async () => DANA });
    const result = await verify('bevel_myself');
    expect(result).toEqual({ ok: true, auth: { source: 'external', userId: DANA.id, tokenId: 'k1', scope: 'write' } });
    expect(bots.resolveConnection).not.toHaveBeenCalled();
  });

  it('a bot: the call acts as the bot\'s row, and keeps the person who made the connection', async () => {
    const bots = botsAnswering(() => asOps(DANA));
    const verify = createTokenVerifier(keys, internal, undefined, undefined, { bots, userOf: async () => DANA });
    const result = await verify('bevel_bot');
    if (!result.ok) throw new Error('refused');
    expect(result.auth.userId).toBe(OPS.id);
    expect(result.auth.madeBy).toEqual(DANA);
    expect(result.auth.connection?.isMyself()).toBe(false);
    expect(result.auth.connection?.toWire()).toEqual({ agent: { path: OPS.email, name: 'ops' } });
    expect(bots.resolveConnection).toHaveBeenCalledWith(DANA, { botUserId: OPS.id, agentPath: null });
  });

  it('asks again on every call: once the person may no longer act as the bot, the next call loads nothing and is not the person', async () => {
    let usable = true;
    const bots = botsAnswering(() =>
      usable
        ? asOps(DANA)
        : { kind: 'unavailable', bot: { id: 'ops', name: 'ops' }, sentence: 'You may no longer act as ops.', reason: 'gone' },
    );
    const verify = createTokenVerifier(keys, internal, undefined, undefined, { bots, userOf: async () => DANA });
    // Both earlier calls act as the bot: the connection is usable before `usable` is switched off.
    for (let i = 0; i < 2; i++) {
      const call = await verify('bevel_bot');
      expect(call.ok).toBe(true);
      if (call.ok) expect(call.auth.userId).toBe(OPS.id);
    }
    usable = false;
    const stopped = await verify('bevel_bot');
    if (!stopped.ok) throw new Error('refused');
    expect(stopped.auth.madeBy).toBeUndefined();
    expect(stopped.auth.connection?.allowsPlatformTool('read_file')).toBe(false);
    expect(stopped.auth.connection?.allowsDiscovery()).toBe(false);
    expect(stopped.auth.connection?.describe()).toBe('You may no longer act as ops.');
    expect(bots.resolveConnection).toHaveBeenCalledTimes(3);
  });

  it('a legacy "as an agent" key is resolved through the bots mechanism like a bot\'s', async () => {
    const bots = botsAnswering(() => asOps(DANA));
    const verify = createTokenVerifier(keys, internal, undefined, undefined, { bots, userOf: async () => DANA });
    const result = await verify('bevel_legacy');
    if (!result.ok) throw new Error('refused');
    expect(result.auth.userId).toBe(OPS.id);
    expect(bots.resolveConnection).toHaveBeenCalledWith(DANA, { botUserId: null, agentPath: 'Agents/ops.agent' });
  });

  it('a credential made as a bot, with no bots mechanism wired, loads nothing', async () => {
    const verify = createTokenVerifier(keys, internal);
    const result = await verify('bevel_bot');
    if (!result.ok) throw new Error('refused');
    expect(result.auth.connection?.allowsPlatformTool('read_file')).toBe(false);
  });

  it('the loopback token the hosted proxy mints for an OAuth connection carries the choice, and resolves as the key does', async () => {
    const bots = botsAnswering(() => asOps(DANA));
    const verify = createTokenVerifier(keys, internal, undefined, undefined, {
      bots,
      userOf: async (id) => (id === DANA.id ? DANA : null),
    });
    const token = internal.mint({ userId: DANA.id, externalProxy: true, botUserId: OPS.id });
    const result = await verify(token);
    if (!result.ok) throw new Error('refused');
    expect(result.auth).toMatchObject({ source: 'external', userId: OPS.id, madeBy: DANA });
  });

  it('an exchanged grant follows its connection\'s CURRENT choice', async () => {
    const bots = botsAnswering(() => asOps(DANA));
    let live: ConnectionChoice | null = { botUserId: OPS.id, agentPath: null };
    const verify = createTokenVerifier(
      keys,
      internal,
      undefined,
      { liveConnectionChoice: async () => live },
      { bots, userOf: async () => DANA },
    );
    const token = internal.mint({ userId: DANA.id, externalProxy: true, connectionId: 'c1' });
    const asBot = await verify(token);
    expect(asBot.ok && asBot.auth.userId).toBe(OPS.id);
    live = { botUserId: null, agentPath: null };
    const asMyself = await verify(token);
    expect(asMyself.ok && asMyself.auth.userId).toBe(DANA.id);
    live = null;
    expect((await verify(token)).ok).toBe(false);
  });
});
