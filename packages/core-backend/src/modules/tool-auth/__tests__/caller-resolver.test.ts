import type { Server as HttpServer } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InternalTokenService } from '../internal-token.service.js';
import {
  createCallerResolver,
  createManualAuthMiddleware,
  createManualTokenVerifier,
  createTokenVerifier,
  createToolAuthMiddleware,
} from '../tool-auth.middleware.js';
import type { IExternalApiKeyService } from '../external-api-key.interface.js';
import { AuthBackendError, type AuthService } from '../../auth/index.js';

/**
 * `createCallerResolver` resolves a bearer for code that calls a hosted read
 * as a function where it used to send the bearer to the read's route. Handed
 * the verifier the route's auth runs, it must answer what that auth answers,
 * at the moment it is asked. So each case here sends the same bearer to a
 * route and to the resolver, both over one set of keys, sessions and accounts
 * that a test can change: a tool route (`toolAuth`) and a manual route
 * (`manualAuth`, which also accepts an app session).
 */
const AGENT = 'Agents/narrow.agent';

let server: HttpServer | undefined;
afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
  vi.restoreAllMocks();
});

async function start() {
  const keys = new Map<string, { user: { id: string }; tokenId: string; agentPath?: string }>([
    ['bevel_plain', { user: { id: 'ada' }, tokenId: 'tok-plain' }],
    ['bevel_as_agent', { user: { id: 'ada' }, tokenId: 'tok-agent', agentPath: AGENT }],
  ]);
  const switchedOff = new Set<string>();
  /** App sessions, by token, and the account each signs in. */
  const sessions = new Map<string, string>([['session_ada', 'ada']]);
  const storeDown = new Error('the database is down');
  const lookupDown = new AuthBackendError(storeDown);
  let keyStoreDown = false;
  let accountsDown = false;
  const keyService = {
    looksLikeExternalApiKey: (t: string) => t.startsWith('bevel_'),
    verifyAndLoadToken: async (t: string) => {
      if (keyStoreDown) throw storeDown;
      return keys.get(t) ?? null;
    },
  } as unknown as IExternalApiKeyService;
  // As the auth service answers: a session is refused once its account is
  // off, and an account that cannot be looked up is an outage, not a refusal.
  const accounts = {
    isActive: async (userId: string) => !switchedOff.has(userId),
    resolveSession: async (token: string) => {
      const userId = sessions.get(token);
      if (!userId) throw new Error('invalid session');
      if (accountsDown) throw lookupDown;
      if (switchedOff.has(userId)) throw new Error('account switched off');
      return { userId, email: `${userId}@example.com` };
    },
  } as unknown as AuthService;
  const internalTokens = new InternalTokenService({ secret: 'test-secret' });

  const app = express();
  app.get('/whoami', createToolAuthMiddleware(keyService, internalTokens, accounts), (req, res) => res.json(req.toolAuth));
  app.get('/whoami-manual', createManualAuthMiddleware(keyService, internalTokens, accounts), (req, res) => res.json(req.toolAuth));
  server = await new Promise<HttpServer>((res) => {
    const s = app.listen(0, () => res(s));
  });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const ask = (path: string) => async (bearer: string) => {
    const res = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${bearer}` } });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  /** What a resolver did with a bearer, in the route's terms: a refusal is its status and its words. */
  const inRouteTerms = (resolve: (bearer: string) => Promise<unknown>) => async (bearer: string) =>
    resolve(bearer).then(
      (auth) => ({ status: 200, body: auth as Record<string, unknown> }),
      (err: unknown) => {
        const status = (err as { status?: unknown }).status;
        if (typeof status !== 'number') throw err;
        return { status, body: { error: (err as Error).message } };
      },
    );
  const resolve = createCallerResolver(createTokenVerifier(keyService, internalTokens, accounts));
  const resolveManual = createCallerResolver(createManualTokenVerifier(keyService, internalTokens, accounts));
  return {
    keys,
    switchedOff,
    internalTokens,
    storeDown,
    lookupDown,
    atTheRoute: ask('/whoami'),
    atTheManualRoute: ask('/whoami-manual'),
    inProcess: inRouteTerms(resolve),
    inProcessManual: inRouteTerms(resolveManual),
    resolve,
    resolveManual,
    takeTheKeyStoreDown: () => {
      keyStoreDown = true;
    },
    takeTheAccountsDown: () => {
      accountsDown = true;
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
    const { resolve, storeDown, takeTheKeyStoreDown } = await start();
    takeTheKeyStoreDown();
    await expect(resolve('bevel_plain')).rejects.toBe(storeDown);
  });
});

describe('createCallerResolver, handed the verifier the manual routes run', () => {
  // The one bearer the two auths answer differently: the manual routes let a
  // person signed in to the app read the catalog with their session.
  it('resolves an app session to the caller its manual route resolves it to, which a tool route refuses', async () => {
    const { atTheRoute, atTheManualRoute, inProcess, inProcessManual } = await start();
    const route = await atTheManualRoute('session_ada');
    expect(route).toEqual({ status: 200, body: { source: 'session', userId: 'ada', scope: 'write' } });
    expect(await inProcessManual('session_ada')).toEqual(route);

    const toolRoute = await atTheRoute('session_ada');
    expect(toolRoute.status).toBe(401);
    expect(await inProcess('session_ada')).toEqual(toolRoute);
  });

  it('resolves a connection key and the token minted for a caller with no key as its manual route does', async () => {
    const { internalTokens, atTheManualRoute, inProcessManual } = await start();
    for (const bearer of [
      'bevel_plain',
      'bevel_as_agent',
      internalTokens.mint({ userId: 'ada', externalProxy: true, agentPath: AGENT }),
    ]) {
      const route = await atTheManualRoute(bearer);
      expect(route.status).toBe(200);
      expect(await inProcessManual(bearer)).toEqual(route);
    }
  });

  it("refuses a session that is not valid, or whose account was switched off, with the manual route's status and words", async () => {
    const { switchedOff, atTheManualRoute, inProcessManual } = await start();
    const unknown = await atTheManualRoute('session_nobody');
    expect(unknown).toEqual({ status: 401, body: { error: 'Invalid or expired token' } });
    expect(await inProcessManual('session_nobody')).toEqual(unknown);

    switchedOff.add('ada');
    const off = await atTheManualRoute('session_ada');
    expect(off.status).toBe(401);
    expect(await inProcessManual('session_ada')).toEqual(off);
  });

  it("refuses a key revoked after it was last resolved, with the manual route's status and words", async () => {
    const { keys, atTheManualRoute, inProcessManual } = await start();
    expect((await inProcessManual('bevel_plain')).status).toBe(200);
    keys.delete('bevel_plain');
    const route = await atTheManualRoute('bevel_plain');
    expect(route.status).toBe(401);
    expect(await inProcessManual('bevel_plain')).toEqual(route);
  });

  // The route answers an outage 500, not 401, so a valid caller is not
  // signed out over it; the resolver throws what the lookup threw.
  it('throws on an account lookup that did not answer, where its manual route answers 500', async () => {
    const { atTheManualRoute, resolveManual, lookupDown, takeTheAccountsDown } = await start();
    takeTheAccountsDown();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await atTheManualRoute('session_ada')).status).toBe(500);
    await expect(resolveManual('session_ada')).rejects.toBe(lookupDown);
  });
});
