import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOAuthConsentRoutes, NOT_AN_AGENT_CHOICE } from '../oauth/oauth-consent.routes.js';
import { signAuthRequest } from '../oauth/oauth-state.js';
import { agentFile, agentScopeOver, inMemoryKb } from '../../agent-scope/__tests__/in-memory-kb.js';

/**
 * The consent step's "Connect as" choice, through the two routes the
 * /connect page calls: the request description offers the agents the person
 * may read, and Finish hands the provider exactly the choice made — null for
 * Everything — or refuses one that is not on offer, before any code is minted.
 * The choice offered and checked is the REAL agent-scope service's, over a
 * knowledge base held in memory.
 */

const SECRET = 'state-secret';
const ADA = 'ada@example.com';

let http: Server | null = null;
afterEach(async () => {
  if (http) await new Promise<void>((r) => http!.close(() => r()));
  http = null;
});

const kb = inMemoryKb({
  'Agents/mechanic.agent': agentFile('name: delivery-mechanic\ndescription: Moves code around.'),
  'Agents/secret.agent': agentFile('name: secret'),
});
kb.hidden.add('Agents/secret.agent');

async function mount(opts: { email?: string; agents?: Parameters<typeof createOAuthConsentRoutes>[0]['agents'] } = {}) {
  const issueAuthCode = vi.fn(async () => ({ redirectTo: 'https://agent.example.com/cb?code=c1' }));
  const completeConsent = vi.fn(async () => ({ redirectTo: 'https://claude.ai/cb?code=gh' }));
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.userId = 'u1';
    req.userEmail = opts.email ?? ADA;
    next();
  });
  app.use(
    createOAuthConsentRoutes({
      provider: {
        issueAuthCode,
        clientsStore: { getClient: async () => ({ client_name: 'Claude' }) },
      } as never,
      stateSecret: SECRET,
      facade: {
        isFacadeRequest: () => true,
        clientNameFor: () => 'Claude',
        completeConsent,
      },
      agents: opts.agents ?? agentScopeOver(kb),
    }),
  );
  http = app.listen(0);
  await new Promise<void>((r) => http!.once('listening', r));
  const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  return { base, issueAuthCode, completeConsent };
}

const state = (extra: Record<string, unknown> = {}) =>
  signAuthRequest(SECRET, { c: 'client-1', r: 'https://agent.example.com/cb', cc: 'challenge', ...extra });

async function finish(base: string, body: Record<string, unknown>) {
  return fetch(`${base}/mcp/oauth/complete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('the consent step offers "Connect as"', () => {
  it('lists the agents the person may read, by name with description and path — Everything is the page’s own', async () => {
    const { base } = await mount();
    const res = await fetch(`${base}/mcp/oauth/request?state=${encodeURIComponent(state())}`);
    expect(await res.json()).toEqual({
      clientName: 'Claude',
      scope: null,
      resource: null,
      agents: [{ path: 'Agents/mechanic.agent', name: 'delivery-mechanic', description: 'Moves code around.' }],
    });
  });

  it('says so when the agents cannot be listed, rather than passing it off as having none', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failing = {
      listChoices: async () => {
        throw new Error('checkout unavailable');
      },
      choosable: async () => null,
    };
    const { base } = await mount({ agents: failing });
    const res = await fetch(`${base}/mcp/oauth/request?state=${encodeURIComponent(state())}`);
    expect(await res.json()).toEqual({
      clientName: 'Claude',
      scope: null,
      resource: null,
      agents: [],
      agentsUnavailable: true,
    });
  });
});

describe('Finish records the choice', () => {
  it('Everything — no choice, null or empty — reaches the provider as null, exactly as before', async () => {
    const { base, issueAuthCode } = await mount();
    for (const body of [{}, { agentPath: null }, { agentPath: '' }]) {
      const st = state();
      const res = await finish(base, { state: st, ...body });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ redirectTo: 'https://agent.example.com/cb?code=c1' });
    }
    expect(issueAuthCode).toHaveBeenCalledTimes(3);
    for (const call of issueAuthCode.mock.calls as unknown as unknown[][]) expect(call[2]).toBeNull();
  });

  it('an agent on offer reaches the provider as its normalized path', async () => {
    const { base, issueAuthCode } = await mount();
    const res = await finish(base, { state: state(), agentPath: '/Agents/mechanic.agent' });
    expect(res.status).toBe(200);
    expect(issueAuthCode).toHaveBeenCalledWith('u1', expect.objectContaining({ c: 'client-1' }), 'Agents/mechanic.agent');
  });

  it.each([
    ['a file the person may not read', 'Agents/secret.agent'],
    ['a file that does not exist', 'Agents/none.agent'],
    ['a path that is not an agent', 'notes.md'],
    ['a value that is not a path', 42],
  ])('refuses %s with one answer, minting nothing', async (_what, agentPath) => {
    const { base, issueAuthCode } = await mount();
    const res = await finish(base, { state: state(), agentPath });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: NOT_AN_AGENT_CHOICE });
    expect(issueAuthCode).not.toHaveBeenCalled();
  });

  it('refuses a choice on an account linked through the GitHub facade, which has no connection to record it on', async () => {
    const { base, completeConsent } = await mount();
    const res = await finish(base, { state: state({ gh: true, cc: undefined }), agentPath: 'Agents/mechanic.agent' });
    expect(res.status).toBe(400);
    expect(completeConsent).not.toHaveBeenCalled();
  });
});
