import type { Server as HttpServer } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { InternalTokenService } from '../internal-token.service.js';
import {
  BearerRefusedError,
  createCallerResolver,
  createTokenVerifier,
  createToolAuthMiddleware,
} from '../tool-auth.middleware.js';
import type { IExternalApiKeyService } from '../external-api-key.interface.js';
import type { AuthService } from '../../auth/index.js';

/**
 * `createCallerResolver` resolves a bearer for code that calls a hosted read
 * as a function where it used to send the bearer to the read's route. It must
 * answer what the route's auth answers, at the moment it is asked. So each
 * case here sends the same bearer to a route behind the tool auth and to the
 * resolver, both over one set of keys and accounts that a test can change.
 */
const AGENT = 'Agents/narrow.agent';

let server: HttpServer | undefined;
afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
});

async function start() {
  const keys = new Map<string, { user: { id: string }; tokenId: string; agentPath?: string }>([
    ['bevel_plain', { user: { id: 'ada' }, tokenId: 'tok-plain' }],
    ['bevel_as_agent', { user: { id: 'ada' }, tokenId: 'tok-agent', agentPath: AGENT }],
  ]);
  const switchedOff = new Set<string>();
  let storeDown = false;
  const keyService = {
    looksLikeExternalApiKey: (t: string) => t.startsWith('bevel_'),
    verifyAndLoadToken: async (t: string) => {
      if (storeDown) throw new Error('the database is down');
      return keys.get(t) ?? null;
    },
  } as unknown as IExternalApiKeyService;
  const accounts = { isActive: async (userId: string) => !switchedOff.has(userId) } as unknown as AuthService;
  const internalTokens = new InternalTokenService({ secret: 'test-secret' });

  const app = express();
  app.get('/whoami', createToolAuthMiddleware(keyService, internalTokens, accounts), (req, res) => res.json(req.toolAuth));
  server = await new Promise<HttpServer>((res) => {
    const s = app.listen(0, () => res(s));
  });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const atTheRoute = async (bearer: string) => {
    const res = await fetch(`${base}/whoami`, { headers: { Authorization: `Bearer ${bearer}` } });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const resolve = createCallerResolver(createTokenVerifier(keyService, internalTokens, accounts));
  /** What the resolver did with a bearer, in the route's terms. */
  const inProcess = async (bearer: string) =>
    resolve(bearer).then(
      (auth) => ({ status: 200, body: auth as unknown as Record<string, unknown> }),
      (err: unknown) => {
        if (!(err instanceof BearerRefusedError)) throw err;
        return { status: err.status, body: { error: err.message } };
      },
    );
  return {
    keys,
    switchedOff,
    internalTokens,
    atTheRoute,
    inProcess,
    resolve,
    takeTheStoreDown: () => {
      storeDown = true;
    },
  };
}

describe('createCallerResolver', () => {
  it('resolves a connection key to the caller its route resolves it to, with the key\'s agent', async () => {
    const { atTheRoute, inProcess } = await start();
    for (const key of ['bevel_plain', 'bevel_as_agent']) {
      const route = await atTheRoute(key);
      expect(route.status).toBe(200);
      expect(await inProcess(key)).toEqual(route);
    }
    expect((await inProcess('bevel_as_agent')).body).toMatchObject({ userId: 'ada', tokenId: 'tok-agent', agentPath: AGENT });
  });

  // A caller with no key (OAuth, or a session): the hosted MCP endpoint mints
  // an `externalProxy` token for the person and the agent of their connection.
  it('resolves the token minted for a caller with no key as its route does', async () => {
    const { internalTokens, atTheRoute, inProcess } = await start();
    for (const claim of [
      { userId: 'ada', externalProxy: true as const },
      { userId: 'ada', externalProxy: true as const, agentPath: AGENT },
    ]) {
      const token = internalTokens.mint(claim);
      const route = await atTheRoute(token);
      expect(route.status).toBe(200);
      expect(route.body.source).toBe('external');
      expect(await inProcess(token)).toEqual(route);
    }
  });

  it('refuses a key revoked after it was last resolved, with the route\'s status and words', async () => {
    const { keys, atTheRoute, inProcess } = await start();
    expect((await inProcess('bevel_plain')).status).toBe(200);
    keys.delete('bevel_plain');
    const route = await atTheRoute('bevel_plain');
    expect(route.status).toBe(401);
    expect(await inProcess('bevel_plain')).toEqual(route);
  });

  it('refuses a minted token once its account is switched off, with the route\'s status and words', async () => {
    const { switchedOff, internalTokens, atTheRoute, inProcess } = await start();
    const token = internalTokens.mint({ userId: 'ada', externalProxy: true });
    expect((await inProcess(token)).status).toBe(200);
    switchedOff.add('ada');
    const route = await atTheRoute(token);
    expect(route.status).toBe(401);
    expect(await inProcess(token)).toEqual(route);
  });

  it('refuses a bearer that is neither a key nor a token of ours', async () => {
    const { atTheRoute, inProcess } = await start();
    const route = await atTheRoute('a-browser-session');
    expect(route.status).toBe(401);
    expect((await inProcess('a-browser-session')).status).toBe(401);
  });

  it('throws on a failure of the key store as it is: an outage is not a verdict on the bearer', async () => {
    const { resolve, takeTheStoreDown } = await start();
    takeTheStoreDown();
    await expect(resolve('bevel_plain')).rejects.toThrow('the database is down');
    await expect(resolve('bevel_plain')).rejects.not.toBeInstanceOf(BearerRefusedError);
  });
});
