import type { Server as HttpServer } from 'node:http';
import { createHmac } from 'node:crypto';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createSecretsVaultRoutes,
  createSecretsVaultPublicRoutes,
  isSafeReturnPath,
} from '../secrets-vault.routes.js';

/**
 * OAUTH `returnTo`: a sign-in started from a page other than /connect must land
 * back on THAT page. The return path rides in the HMAC-signed `state` (field
 * `r`) because the provider's callback arrives un-authenticated — the state is
 * the only thing the callback can trust.
 *
 * The whole risk here is an open redirect: the callback concatenates `r` onto
 * our own public origin and hands it to the browser as a `Location`. So the
 * validation is pinned twice — as a unit table on `isSafeReturnPath`, and
 * end-to-end on both the start route (what gets signed) and the callback (what
 * gets redirected to, re-validated).
 *
 * Backward compatibility is the second thing under test: a start with NO body
 * must produce exactly the state it produced before `returnTo` existed
 * (`r: 'connect'`), and a legacy `'connect'` state must still land on /connect.
 */

const STATE_SECRET = 'test-secret';
const FRONTEND = 'http://localhost:5173';
const TOOL_PATH = 'Tools/weather.tool';
const USER = 'user@x.com';
const RETURN_TO = '/skills-and-tools/tools/weather';

const MANUALS = [
    {
      slug: 'weather',
      name: 'weather',
      path: TOOL_PATH,
      type: 'mcp' as const,
      variables: [
        {
          name: 'SIGNIN',
          scope: 'user' as const,
          label: 'Weather sign-in',
          oauth: {
            authorizationUrl: 'https://auth.example.com/authorize',
            tokenUrl: 'https://auth.example.com/token',
            clientId: 'client-1',
          },
        },
      ],
    },
];

const toolManualService = {
  listAccessible: async () => MANUALS,
  // The un-authed callback resolves which manual a secret belongs to by
  // matching its key against the catalog, so this has to be here for the
  // invalidation to be reachable at all.
  listAllSummaries: async () => MANUALS,
} as unknown as Parameters<typeof createSecretsVaultRoutes>[0]['toolManualService'];

const accessControl = {
  canRead: async () => true,
  canWrite: async () => false, // a plain reader may authorize their OWN account
} as unknown as Parameters<typeof createSecretsVaultRoutes>[0]['accessControl'];

const completeOAuth = vi.fn(async () => {});
const secretsVault = {
  beginToolOAuthByKey: async () => ({ id: 'secret-1', url: 'https://auth.example.com/authorize?client_id=client-1' }),
  completeOAuth,
  // Without this the callback's invalidation dies on a TypeError that its own
  // best-effort catch swallows — the tests would pass while proving nothing.
  getById: async () => ({ id: 'secret-1', key: 'weather_SIGNIN' }),
} as unknown as Parameters<typeof createSecretsVaultRoutes>[0]['secretsVault'];

const forget = vi.fn(async () => {});
const connectionHealth = {
  probe: async () => ({ manualName: '', status: 'unverifiable' as const, detail: null, checkedAt: new Date() }),
  statusFor: async () => [],
  forget,
  forgetAll: async () => {},
} as unknown as Parameters<typeof createSecretsVaultRoutes>[0]['connectionHealth'];

const deps = {
  secretsVault,
  toolManualService,
  accessControl,
  connectionHealth,
  stateSecret: STATE_SECRET,
  publicBackendUrl: 'http://localhost:3000',
  publicFrontendUrl: FRONTEND,
};

let httpServer: HttpServer | undefined;

/** One server carrying BOTH routers, so a start's state can be replayed at the callback. */
async function baseUrl(): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use('/api', createSecretsVaultPublicRoutes(deps)); // un-authed callback, mounted first
  app.use((req, _res, next) => {
    req.userId = `id-${USER}`;
    req.userEmail = USER;
    next();
  });
  app.use('/api', createSecretsVaultRoutes(deps));
  httpServer = await new Promise<HttpServer>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = (httpServer.address() as { port: number }).port;
  return `http://127.0.0.1:${port}`;
}

/** POST the start route with (or without) a body; return the signed `state` it put on the consent URL. */
async function startAndReadState(base: string, body?: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${base}/api/secrets/tools/weather/vars/SIGNIN/oauth/start`, {
    method: 'POST',
    ...(body === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  expect(res.status).toBe(200);
  const { url } = (await res.json()) as { url: string };
  const state = new URL(url).searchParams.get('state')!;
  expect(state).toBeTruthy();
  return decodeState(state);
}

/** Decode a signed state's payload (the signature is verified by the callback tests). */
function decodeState(token: string): Record<string, unknown> {
  const [body] = token.split('.');
  return JSON.parse(Buffer.from(body, 'base64url').toString()) as Record<string, unknown>;
}

/** Sign a state the way the routes do — used to drive the callback directly. */
function signState(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify({ iat: Date.now(), ...payload })).toString('base64url');
  const sig = createHmac('sha256', STATE_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

/** Follow no redirects — the Location header IS the assertion. */
async function callback(base: string, state: string): Promise<string> {
  const res = await fetch(`${base}/api/secrets/oauth/callback?code=abc&state=${encodeURIComponent(state)}`, {
    redirect: 'manual',
  });
  expect(res.status).toBe(302);
  return res.headers.get('location')!;
}

afterEach(async () => {
  if (httpServer) await new Promise<void>((r) => httpServer!.close(() => r()));
  httpServer = undefined;
  completeOAuth.mockClear();
  completeOAuth.mockImplementation(async () => {});
  vi.restoreAllMocks();
});

describe('isSafeReturnPath', () => {
  it.each([
    ['/secrets', true],
    ['/skills-and-tools/tools/weather', true],
    ['/', true],
    ['/a?b=c&d=e', true], // a query is fine — it stays on our origin
    ['/' + 'a'.repeat(511), true], // exactly 512 chars
  ])('accepts %j', (value, expected) => {
    expect(isSafeReturnPath(value)).toBe(expected);
  });

  it.each([
    ['//evil.com', 'protocol-relative — leaves our origin'],
    ['https://evil.com', 'absolute URL'],
    ['http://evil.com', 'absolute URL'],
    ['/\\evil.com', 'backslash folds to a slash in WHATWG http(s)'],
    ['\\\\evil.com', 'backslash, no leading slash'],
    ['/ok#fragment', 'would swallow the #authorized fragment'],
    ['/ok\r\nSet-Cookie: a=b', 'response splitting'],
    ['/ok\nX: y', 'response splitting'],
    ['secrets', 'relative — no leading slash'],
    ['', 'empty'],
    ['/' + 'a'.repeat(512), '513 chars — over the state budget'],
  ])('rejects %j (%s)', (value) => {
    expect(isSafeReturnPath(value)).toBe(false);
  });

  it.each([[undefined], [null], [42], [{}], [['/ok']], [true]])('rejects the non-string %j', (value) => {
    expect(isSafeReturnPath(value)).toBe(false);
  });
});

describe('POST …/oauth/start — what gets signed into the state', () => {
  it('signs a valid returnTo verbatim as `r`', async () => {
    const state = await startAndReadState(await baseUrl(), { returnTo: RETURN_TO });
    expect(state.r).toBe(RETURN_TO);
    expect(state.u).toBe(`id-${USER}`);
    expect(state.i).toBe('secret-1');
  });

  it('falls back to the legacy `connect` marker with NO body — byte-identical to the old behavior', async () => {
    const state = await startAndReadState(await baseUrl());
    expect(state.r).toBe('connect');
  });

  it('falls back to `connect` for an empty body and an absent returnTo', async () => {
    const base = await baseUrl();
    expect((await startAndReadState(base, {})).r).toBe('connect');
    expect((await startAndReadState(base, { returnTo: undefined })).r).toBe('connect');
  });

  it.each([
    ['//evil.com'],
    ['https://evil.com'],
    ['/ok#fragment'],
    ['/\\evil.com'],
    ['/' + 'a'.repeat(512)],
    ['/ok\r\nSet-Cookie: a=b'],
    ['not-a-path'],
    [42],
    [{ nested: true }],
  ])('refuses %j and falls back to `connect`', async (returnTo) => {
    const state = await startAndReadState(await baseUrl(), { returnTo });
    expect(state.r).toBe('connect');
  });
});

describe('GET /api/secrets/oauth/callback — where the browser lands', () => {
  it('returns to a signed same-origin path', async () => {
    const base = await baseUrl();
    const state = signState({ u: 'u1', i: 'secret-1', n: 'nonce', r: RETURN_TO });
    expect(await callback(base, state)).toBe(`${FRONTEND}${RETURN_TO}#authorized=secret-1`);
  });

  it('invalidates the verdict the new sign-in supersedes', async () => {
    // A fresh token replaces whatever the last probe concluded — including a
    // `failed` from the expired session the user just signed in to fix, which
    // would otherwise keep accusing a credential that no longer exists.
    const base = await baseUrl();
    const state = signState({ u: 'u1', i: 'secret-1', n: 'nonce', r: RETURN_TO });
    await callback(base, state);
    expect(forget).toHaveBeenCalledWith('u1', 'weather');
  });

  it('still lands the browser even when that invalidation fails', async () => {
    // The sign-in itself SUCCEEDED; a bookkeeping failure must not send the
    // user to an error page for it.
    forget.mockRejectedValueOnce(new Error('db down'));
    const base = await baseUrl();
    const state = signState({ u: 'u1', i: 'secret-1', n: 'nonce', r: RETURN_TO });
    expect(await callback(base, state)).toBe(`${FRONTEND}${RETURN_TO}#authorized=secret-1`);
  });

  it('still lands a legacy `connect` state on /connect', async () => {
    const base = await baseUrl();
    const state = signState({ u: 'u1', i: 'secret-1', n: 'nonce', r: 'connect' });
    expect(await callback(base, state)).toBe(`${FRONTEND}/connect#authorized=secret-1`);
  });

  it('lands a state with no `r` on /secrets (the standalone Secrets flow)', async () => {
    const base = await baseUrl();
    const state = signState({ u: 'u1', i: 'secret-1', n: 'nonce' });
    expect(await callback(base, state)).toBe(`${FRONTEND}/secrets#authorized=secret-1`);
  });

  it.each([['//evil.com'], ['https://evil.com'], ['/ok#frag'], ['/\\evil.com'], ['/ok\r\nX: y']])(
    'refuses an unsafe `r` (%j) at CALLBACK time and falls back to /secrets',
    async (unsafe) => {
      // Defense in depth: this `r` is correctly signed — it could only exist if
      // the signing key leaked or the start-side validation regressed. The
      // callback re-checks anyway, because it is the line that builds the
      // Location header.
      const base = await baseUrl();
      const state = signState({ u: 'u1', i: 'secret-1', n: 'nonce', r: unsafe });
      expect(await callback(base, state)).toBe(`${FRONTEND}/secrets#authorized=secret-1`);
    },
  );

  it('puts the error fragment on the RESOLVED destination when the exchange fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    completeOAuth.mockImplementation(async () => {
      throw new Error('token endpoint said no');
    });
    const base = await baseUrl();
    const state = signState({ u: 'u1', i: 'secret-1', n: 'nonce', r: RETURN_TO });
    const location = await callback(base, state);
    expect(location.startsWith(`${FRONTEND}${RETURN_TO}#error=`)).toBe(true);
    // The user-facing message is generic — provider detail stays in the log.
    expect(decodeURIComponent(location.split('#error=')[1])).toBe(
      'Authorization failed. Check the provider configuration and try again.',
    );
  });

  it('lands PRE-verification errors on /secrets, unchanged', async () => {
    const base = await baseUrl();
    // A tampered state can't be trusted for `r`, so its destination is the
    // fallback — this is the behavior `returnTo` must not have altered.
    const res = await fetch(`${base}/api/secrets/oauth/callback?code=abc&state=garbage.sig`, {
      redirect: 'manual',
    });
    expect(res.headers.get('location')).toBe(
      `${FRONTEND}/secrets#error=${encodeURIComponent('OAuth state mismatch.')}`,
    );
    const noCode = await fetch(`${base}/api/secrets/oauth/callback`, { redirect: 'manual' });
    expect(noCode.headers.get('location')).toBe(
      `${FRONTEND}/secrets#error=${encodeURIComponent('Invalid OAuth callback.')}`,
    );
  });

  it('round-trips a returnTo end to end: start signs it, callback honors it', async () => {
    const base = await baseUrl();
    const res = await fetch(`${base}/api/secrets/tools/weather/vars/SIGNIN/oauth/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ returnTo: RETURN_TO }),
    });
    const { url } = (await res.json()) as { url: string };
    const state = new URL(url).searchParams.get('state')!;
    expect(await callback(base, state)).toBe(`${FRONTEND}${RETURN_TO}#authorized=secret-1`);
  });
});
