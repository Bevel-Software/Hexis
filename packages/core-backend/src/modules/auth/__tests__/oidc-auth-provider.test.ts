import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { OidcAuthProvider } from '../oidc-auth-provider.js';
import type { AuthService } from '../auth.service.js';

const ISSUER = 'https://idp.example.com';
const DISCOVERY = {
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: `${ISSUER}/token`,
  userinfo_endpoint: `${ISSUER}/userinfo`,
};

function makeProvider(fetchImpl: typeof fetch, authService: AuthService) {
  const provider = new OidcAuthProvider({
    issuerUrl: ISSUER,
    clientId: 'client-1',
    clientSecret: 'secret-1',
    scopes: 'openid profile email',
    label: 'Sign in with Example',
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
      issuerUrl: ISSUER,
      clientId: 'c',
      clientSecret: 's',
      scopes: 'openid',
      label: 'Sign in with Example',
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
