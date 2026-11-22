import http from 'node:http';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createOAuthConsentRoutes, NOT_A_BOT_CHOICE } from '../oauth/oauth-consent.routes.js';
import { signAuthRequest } from '../oauth/oauth-state.js';
import type { BevelOAuthProvider } from '../oauth/bevel-oauth-provider.js';

/**
 * The consent's Finish, where a "Connect as" choice is made: Myself when no
 * bot is named, a bot the person may act as, and nothing else. A page from
 * before bots names its choice as `agentPath`; read as absent it would
 * connect as Myself with the person's whole access, so it is refused.
 */

const SECRET = 'consent-test-secret';
const issueAuthCode = vi.fn(async () => ({ redirectTo: 'https://client.example/cb?code=c' }));
let server: http.Server;
let base = '';

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.userId = 'u-dana';
    req.userEmail = 'dana@acme.com';
    next();
  });
  app.use(
    createOAuthConsentRoutes({
      provider: { issueAuthCode } as unknown as BevelOAuthProvider,
      stateSecret: SECRET,
      bots: {
        choicesFor: async () => [],
        actAs: async (_e: string, id: string) =>
          id === 'ops' ? { id: 'u-ops', email: 'ops@agent.hexis', botId: 'ops', name: 'Ops' } : null,
      },
    }),
  );
  server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const finish = (body: Record<string, unknown>) =>
  fetch(`${base}/mcp/oauth/complete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ state: signAuthRequest(SECRET, { c: 'client-1', r: 'https://client.example/cb', cc: 'x' }), ...body }),
  });

describe('the consent\'s Finish', () => {
  it('refuses a body that names its choice as agentPath, and issues no code', async () => {
    issueAuthCode.mockClear();
    const res = await finish({ agentPath: 'Agents/release.agent' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(NOT_A_BOT_CHOICE);
    expect(issueAuthCode).not.toHaveBeenCalled();
  });

  it('connects as a bot the person may act as, and as Myself when none is named', async () => {
    issueAuthCode.mockClear();
    expect((await finish({ bot: 'ops' })).status).toBe(200);
    expect((await finish({})).status).toBe(200);
    expect(issueAuthCode.mock.calls.map((c) => (c as unknown[])[2])).toEqual(['u-ops', null]);
  });
});
