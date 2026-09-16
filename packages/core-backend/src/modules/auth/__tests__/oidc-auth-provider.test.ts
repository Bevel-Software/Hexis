import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { OidcAuthProvider, oidcSettingsFrom, type OidcSettings } from '../oidc-auth-provider.js';
import { createAuthRoutes, type AuthProviderPlugin } from '../auth.routes.js';
import type { AuthService } from '../auth.service.js';
import {
  CORE_SETTINGS,
  DeploymentSettingsService,
} from '../../settings/deployment-settings.service.js';
import type { Database } from '../../database/connection.js';

const ISSUER = 'https://idp.example.com';
const DISCOVERY = {
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: `${ISSUER}/token`,
  userinfo_endpoint: `${ISSUER}/userinfo`,
};

const CONFIGURED: OidcSettings = {
  issuerUrl: ISSUER,
  clientId: 'client-1',
  clientSecret: 'secret-1',
  scopes: 'openid profile email',
  label: 'Sign in with Example',
};

function makeProvider(
  fetchImpl: typeof fetch,
  authService: AuthService,
  settings: () => OidcSettings | null = () => CONFIGURED,
) {
  const provider = new OidcAuthProvider({
    settings,
    publicBackendUrl: 'http://localhost:3001',
    publicFrontendUrl: 'http://localhost:5173',
    cookieSecure: false,
    fetchImpl,
  });
  const router = express.Router();
  provider.mountRoutes(router, authService);
  const app = express();
  app.use('/api', router);
  return app;
}

/** fetch stub that serves discovery, token and userinfo; records requests. */
function makeIdpFetch(overrides: { userinfo?: Record<string, unknown> } = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith('/.well-known/openid-configuration')) {
      return new Response(JSON.stringify(DISCOVERY), { status: 200 });
    }
    if (url === DISCOVERY.token_endpoint) {
      return new Response(JSON.stringify({ access_token: 'at-123' }), { status: 200 });
    }
    if (url === DISCOVERY.userinfo_endpoint) {
      return new Response(
        JSON.stringify(overrides.userinfo ?? { email: 'carol@example.com', name: 'Carol' }),
        { status: 200 },
      );
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

let server: Server;
afterEach(() => {
  server?.close();
});

async function listen(app: express.Express): Promise<string> {
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  const address = server.address();
  if (typeof address === 'string' || !address) throw new Error('no port');
  return `http://127.0.0.1:${address.port}`;
}

const authService = {
  loginWithSso: vi.fn(async (email: string) => ({
    token: 'jwt-for-' + email,
    user: { id: 'u', email, name: 'Carol' },
  })),
} as unknown as AuthService;

beforeEach(() => {
  vi.mocked(authService.loginWithSso).mockClear();
});

describe('OidcAuthProvider', () => {
  it('advertises key/label/startPath for the login screen', () => {
    const provider = new OidcAuthProvider({
      settings: () => CONFIGURED,
      publicBackendUrl: 'http://localhost:3001',
      publicFrontendUrl: 'http://localhost:5173',
      cookieSecure: false,
    });
    expect(provider.key).toBe('oidc');
    expect(provider.label).toBe('Sign in with Example');
    expect(provider.startPath).toBe('/api/auth/oidc/login');
  });

  it('login redirects to the authorization endpoint with PKCE + state, setting the state cookie', async () => {
    const idp = makeIdpFetch();
    const base = await listen(makeProvider(idp.impl, authService));
    const res = await fetch(`${base}/api/auth/oidc/login`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location')!);
    expect(location.origin + location.pathname).toBe(DISCOVERY.authorization_endpoint);
    expect(location.searchParams.get('client_id')).toBe('client-1');
    expect(location.searchParams.get('response_type')).toBe('code');
    expect(location.searchParams.get('redirect_uri')).toBe(
      'http://localhost:3001/api/auth/oidc/callback',
    );
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    expect(location.searchParams.get('state')).toMatch(/^[0-9a-f]{32}$/);
    expect(res.headers.get('set-cookie')).toContain('oidc_oauth_state=');
  });

  it('callback exchanges the code, reads userinfo, and redirects with the app JWT in the fragment', async () => {
    const idp = makeIdpFetch();
    const base = await listen(makeProvider(idp.impl, authService));

    const start = await fetch(`${base}/api/auth/oidc/login`, { redirect: 'manual' });
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const cookie = start.headers.get('set-cookie')!.split(';')[0];

    const cb = await fetch(
      `${base}/api/auth/oidc/callback?code=code-1&state=${state}`,
      { redirect: 'manual', headers: { cookie } },
    );
    expect(cb.status).toBe(302);
    expect(cb.headers.get('location')).toBe(
      'http://localhost:5173/auth/oidc/callback#token=' +
        encodeURIComponent('jwt-for-carol@example.com'),
    );
    // Session cookie set alongside the fragment hand-off.
    expect(cb.headers.get('set-cookie')).toContain('bevel_token=');

    // Token exchange used PKCE (verifier from the cookie) + Basic client auth.
    const tokenCall = idp.calls.find((c) => c.url === DISCOVERY.token_endpoint)!;
    const body = String(tokenCall.init?.body);
    expect(body).toContain('grant_type=authorization_code');
    expect(body).toContain('code_verifier=');
    expect((tokenCall.init?.headers as Record<string, string>).Authorization).toMatch(/^Basic /);
    // userinfo was called with the freshly exchanged access token.
    const infoCall = idp.calls.find((c) => c.url === DISCOVERY.userinfo_endpoint)!;
    expect((infoCall.init?.headers as Record<string, string>).Authorization).toBe('Bearer at-123');
    expect(authService.loginWithSso).toHaveBeenCalledWith('carol@example.com', 'Carol');
  });

  it('rejects a state mismatch without touching the token endpoint', async () => {
    const idp = makeIdpFetch();
    const base = await listen(makeProvider(idp.impl, authService));
    const start = await fetch(`${base}/api/auth/oidc/login`, { redirect: 'manual' });
    const cookie = start.headers.get('set-cookie')!.split(';')[0];
    const cb = await fetch(`${base}/api/auth/oidc/callback?code=code-1&state=forged`, {
      redirect: 'manual',
      headers: { cookie },
    });
    expect(cb.headers.get('location')).toBe('http://localhost:5173/auth/oidc/callback#error=state');
    expect(idp.calls.some((c) => c.url === DISCOVERY.token_endpoint)).toBe(false);
    expect(authService.loginWithSso).not.toHaveBeenCalled();
  });

  it('fails with #error=auth when userinfo has no email claim', async () => {
    const idp = makeIdpFetch({ userinfo: { name: 'No Email' } });
    const base = await listen(makeProvider(idp.impl, authService));
    const start = await fetch(`${base}/api/auth/oidc/login`, { redirect: 'manual' });
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const cookie = start.headers.get('set-cookie')!.split(';')[0];
    const cb = await fetch(`${base}/api/auth/oidc/callback?code=c&state=${state}`, {
      redirect: 'manual',
      headers: { cookie },
    });
    expect(cb.headers.get('location')).toBe('http://localhost:5173/auth/oidc/callback#error=auth');
    expect(authService.loginWithSso).not.toHaveBeenCalled();
  });
});

/**
 * The provider is registered once at boot and reads its configuration on every
 * use, so SSO saved on a running deployment — or changed on one — applies to
 * the next sign-in without a restart.
 */
describe('OidcAuthProvider — live configuration', () => {
  /** Same in-memory stand-in for `deployment_settings` the settings tests use. */
  function makeDb() {
    const rows: { key: string; value: string; encrypted: boolean }[] = [];
    return {
      select: () => ({ from: () => Promise.resolve(rows.map((r) => ({ ...r }))) }),
      insert: () => ({
        values: (v: { key: string; value: string; encrypted: boolean }) => ({
          onConflictDoUpdate: () => {
            const existing = rows.find((r) => r.key === v.key);
            if (existing) Object.assign(existing, v);
            else rows.push({ key: v.key, value: v.value, encrypted: v.encrypted });
            return Promise.resolve();
          },
        }),
      }),
      delete: () => ({ where: () => Promise.resolve() }),
    } as unknown as Database;
  }

  let savedEnv: NodeJS.ProcessEnv;
  beforeEach(() => {
    savedEnv = { ...process.env };
    for (const def of CORE_SETTINGS) delete process.env[def.envVar];
  });
  afterEach(() => {
    process.env = savedEnv;
  });

  /** The real auth router over real settings, with an overlay plugin beside OIDC. */
  async function boot(fetchImpl: typeof fetch = makeIdpFetch().impl) {
    const settings = new DeploymentSettingsService(makeDb(), randomBytes(32).toString('base64'));
    const overlay: AuthProviderPlugin = {
      key: 'microsoft',
      label: 'Sign in with Microsoft',
      startPath: '/api/auth/microsoft/login',
      mountRoutes: () => {},
    };
    const oidc = new OidcAuthProvider({
      settings: () => oidcSettingsFrom(settings),
      publicBackendUrl: 'http://localhost:3001',
      publicFrontendUrl: 'http://localhost:5173',
      cookieSecure: false,
      fetchImpl,
    });
    const app = express();
    app.use(express.json());
    app.use(
      '/api',
      createAuthRoutes(authService, (_req, _res, next) => next(), [overlay, oidc]),
    );
    const base = await listen(app);
    const probe = async () =>
      ((await (await fetch(`${base}/api/auth/providers`)).json()) as {
        sso: { key: string; label: string; startPath: string }[];
      }).sso;
    return { base, settings, probe };
  }

  it('is advertised only once issuer, client id and secret are all configured', async () => {
    const { settings, probe } = await boot();
    expect((await probe()).map((p) => p.key)).toEqual(['microsoft']);

    await settings.save({ oidcIssuerUrl: ISSUER, oidcClientId: 'client-1' }, null);
    expect((await probe()).map((p) => p.key)).toEqual(['microsoft']);

    await settings.save({ oidcClientSecret: 'secret-1' }, null);
    expect(await probe()).toEqual([
      { key: 'microsoft', label: 'Sign in with Microsoft', startPath: '/api/auth/microsoft/login' },
      { key: 'oidc', label: 'Single sign-on', startPath: '/api/auth/oidc/login' },
    ]);
  });

  it('login while unconfigured sends the browser back to sign-in with an error, not a 500', async () => {
    const idp = makeIdpFetch();
    const { base, settings } = await boot(idp.impl);
    await settings.save({ oidcIssuerUrl: ISSUER, oidcClientId: 'client-1' }, null);
    const res = await fetch(`${base}/api/auth/oidc/login`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(
      'http://localhost:5173/auth/oidc/callback#error=not_configured',
    );
    expect(idp.calls).toEqual([]);
  });

  it('reads the label and scopes live, and a saved configuration starts a working sign-in', async () => {
    const { base, settings, probe } = await boot();
    await settings.save(
      { oidcIssuerUrl: ISSUER, oidcClientId: 'client-1', oidcClientSecret: 'secret-1' },
      null,
    );
    await settings.save({ oidcProviderLabel: 'Company SSO', oidcScopes: 'openid email' }, null);
    expect((await probe()).find((p) => p.key === 'oidc')?.label).toBe('Company SSO');

    const start = await fetch(`${base}/api/auth/oidc/login`, { redirect: 'manual' });
    const location = new URL(start.headers.get('location')!);
    expect(location.origin + location.pathname).toBe(DISCOVERY.authorization_endpoint);
    expect(location.searchParams.get('scope')).toBe('openid email');
    expect(location.searchParams.get('client_id')).toBe('client-1');

    await settings.save({ oidcProviderLabel: 'Acme login', oidcClientId: 'client-2' }, null);
    expect((await probe()).find((p) => p.key === 'oidc')?.label).toBe('Acme login');
    const again = await fetch(`${base}/api/auth/oidc/login`, { redirect: 'manual' });
    expect(new URL(again.headers.get('location')!).searchParams.get('client_id')).toBe('client-2');
  });

  it('re-discovers a changed issuer instead of reusing the old document', async () => {
    const OTHER = 'https://other-idp.example.com';
    const discovered: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      discovered.push(url);
      const issuer = url.replace('/.well-known/openid-configuration', '');
      return new Response(
        JSON.stringify({
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          userinfo_endpoint: `${issuer}/userinfo`,
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const { base, settings } = await boot(fetchImpl);
    await settings.save(
      { oidcIssuerUrl: ISSUER, oidcClientId: 'client-1', oidcClientSecret: 'secret-1' },
      null,
    );
    const login = async () =>
      new URL(
        (await fetch(`${base}/api/auth/oidc/login`, { redirect: 'manual' })).headers.get(
          'location',
        )!,
      ).origin;

    expect(await login()).toBe(ISSUER);
    expect(await login()).toBe(ISSUER);
    expect(discovered).toHaveLength(1); // cached while the issuer is unchanged

    await settings.save({ oidcIssuerUrl: `${OTHER}/` }, null);
    expect(await login()).toBe(OTHER);
    expect(discovered).toEqual([
      `${ISSUER}/.well-known/openid-configuration`,
      `${OTHER}/.well-known/openid-configuration`,
    ]);
  });

  it('exchanges the code with a rotated client secret on the next sign-in', async () => {
    const idp = makeIdpFetch();
    const { base, settings } = await boot(idp.impl);
    await settings.save(
      { oidcIssuerUrl: ISSUER, oidcClientId: 'client-1', oidcClientSecret: 'secret-1' },
      null,
    );
    const signIn = async () => {
      const start = await fetch(`${base}/api/auth/oidc/login`, { redirect: 'manual' });
      const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
      const cookie = start.headers.get('set-cookie')!.split(';')[0];
      const cb = await fetch(`${base}/api/auth/oidc/callback?code=code-1&state=${state}`, {
        redirect: 'manual',
        headers: { cookie },
      });
      expect(cb.headers.get('location')).toContain('#token=');
      const exchange = idp.calls.filter((c) => c.url === DISCOVERY.token_endpoint).at(-1)!;
      return (exchange.init!.headers as Record<string, string>).Authorization;
    };
    const basic = (secret: string) =>
      `Basic ${Buffer.from(`client-1:${secret}`).toString('base64')}`;

    expect(await signIn()).toBe(basic('secret-1'));
    await settings.save({ oidcClientSecret: 'secret-2' }, null);
    expect(await signIn()).toBe(basic('secret-2'));
  });

  it('shares one discovery fetch between concurrent sign-ins', async () => {
    const idp = makeIdpFetch();
    // A slow issuer, so every sign-in arrives while discovery is still in flight.
    const slow = (async (input: RequestInfo | URL, init?: RequestInit) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return idp.impl(input, init);
    }) as typeof fetch;
    const { base, settings } = await boot(slow);
    await settings.save(
      { oidcIssuerUrl: ISSUER, oidcClientId: 'client-1', oidcClientSecret: 'secret-1' },
      null,
    );
    const starts = await Promise.all(
      Array.from({ length: 5 }, () => fetch(`${base}/api/auth/oidc/login`, { redirect: 'manual' })),
    );
    for (const res of starts) {
      expect(new URL(res.headers.get('location')!).origin).toBe(ISSUER);
    }
    expect(idp.calls.filter((c) => c.url.endsWith('/openid-configuration'))).toHaveLength(1);
  });

  it('re-discovers the original issuer when switched back after a failed change', async () => {
    const BROKEN = 'https://broken-idp.example.com';
    const discovered: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      discovered.push(url);
      if (url.startsWith(BROKEN)) return new Response('down', { status: 503 });
      return new Response(JSON.stringify(DISCOVERY), { status: 200 });
    }) as unknown as typeof fetch;
    const { base, settings } = await boot(fetchImpl);
    await settings.save(
      { oidcIssuerUrl: ISSUER, oidcClientId: 'client-1', oidcClientSecret: 'secret-1' },
      null,
    );
    const login = async () =>
      (await fetch(`${base}/api/auth/oidc/login`, { redirect: 'manual' })).headers.get('location')!;

    expect(await login()).toContain(DISCOVERY.authorization_endpoint);
    await settings.save({ oidcIssuerUrl: BROKEN }, null);
    expect(await login()).toBe('http://localhost:5173/auth/oidc/callback#error=start');
    await settings.save({ oidcIssuerUrl: ISSUER }, null);
    expect(await login()).toContain(DISCOVERY.authorization_endpoint);
    expect(discovered).toEqual([
      `${ISSUER}/.well-known/openid-configuration`,
      `${BROKEN}/.well-known/openid-configuration`,
      `${ISSUER}/.well-known/openid-configuration`,
    ]);
  });

  it('keeps an environment-configured provider exactly as the environment says', async () => {
    process.env.OIDC_ISSUER_URL = ISSUER;
    process.env.OIDC_CLIENT_ID = 'env-client';
    process.env.OIDC_CLIENT_SECRET = 'env-secret';
    process.env.OIDC_PROVIDER_LABEL = 'Env SSO';
    const { base, settings, probe } = await boot();
    expect((await probe()).find((p) => p.key === 'oidc')?.label).toBe('Env SSO');

    // A UI save cannot override an environment value — it is refused outright.
    await expect(settings.save({ oidcClientId: 'ui-client' }, null)).rejects.toThrow();
    // …while a setting the environment left unset is still a fallback.
    await settings.save({ oidcScopes: 'openid email profile offline_access' }, null);

    const start = await fetch(`${base}/api/auth/oidc/login`, { redirect: 'manual' });
    const location = new URL(start.headers.get('location')!);
    expect(location.searchParams.get('client_id')).toBe('env-client');
    expect(location.searchParams.get('scope')).toBe('openid email profile offline_access');
  });
});

describe('oidcSettingsFrom', () => {
  const from = (values: Record<string, string>) =>
    oidcSettingsFrom({ resolve: (key) => values[key] ?? '' });

  it('is null until issuer, client id and secret are all set', () => {
    expect(from({})).toBeNull();
    expect(from({ oidcIssuerUrl: ISSUER, oidcClientId: 'c' })).toBeNull();
    expect(from({ oidcClientId: 'c', oidcClientSecret: 's' })).toBeNull();
  });

  it('fills the scope and label defaults and strips a trailing slash from the issuer', () => {
    expect(from({ oidcIssuerUrl: `${ISSUER}//`, oidcClientId: 'c', oidcClientSecret: 's' })).toEqual({
      issuerUrl: ISSUER,
      clientId: 'c',
      clientSecret: 's',
      scopes: 'openid profile email',
      label: 'Single sign-on',
    });
  });
});
