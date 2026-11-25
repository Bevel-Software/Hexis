import { afterAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AuthService } from '../auth.service.js';
import { createAuthRoutes } from '../auth.routes.js';
import { OidcAuthProvider, oidcSettingsFrom } from '../oidc-auth-provider.js';
import { PG_ADMIN_URL, PG_TEST_TIMEOUT, dropScratchDatabases, openMigratedScratchDb } from '../../../__tests__/pg-scratch.js';
import { realDeploymentSettingsOn } from '../../../__tests__/real-settings.js';

/**
 * Removing the single sign-on provider deletes its saved settings, while the
 * accounts single sign-on created stay and password sign-in goes on working. Settings and accounts live in one database, so this crosses a real
 * Postgres (see `pg-scratch.ts`) with the real auth service, the real auth
 * routes and the provider wired as the composition root wires it.
 */
const ISSUER = 'https://idp.example.com';
const DISCOVERY = {
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: `${ISSUER}/token`,
  userinfo_endpoint: `${ISSUER}/userinfo`,
};

const idpFetch = (async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.endsWith('/.well-known/openid-configuration')) return Response.json(DISCOVERY);
  if (url === DISCOVERY.token_endpoint) return Response.json({ access_token: 'at' });
  if (url === DISCOVERY.userinfo_endpoint) return Response.json({ email: 'carol@example.com', name: 'Carol' });
  return new Response('', { status: 404 });
}) as typeof fetch;

const closers: Array<() => Promise<void>> = [];
const servers: Server[] = [];

describe.skipIf(!PG_ADMIN_URL)('removing the single sign-on provider, on a real Postgres', () => {
  afterAll(async () => {
    for (const s of servers) await new Promise<void>((resolve, reject) => s.close((error) => (error ? reject(error) : resolve())));
    for (const close of closers) await close();
    await dropScratchDatabases();
  }, PG_TEST_TIMEOUT);

  it(
    'keeps the accounts single sign-on created, and password sign-in still succeeds',
    async () => {
      const { db, close } = await openMigratedScratchDb('hexis_oidc_removal');
      closers.push(close);
      const auth = new AuthService(db, {
        jwtSecret: 'test-jwt-secret',
        adminEmail: '',
        adminPassword: '',
        allowedEmailDomains: [],
      });
      const settings = realDeploymentSettingsOn(db);
      const oidc = new OidcAuthProvider({
        settings: () => oidcSettingsFrom(settings),
        publicBackendUrl: 'http://localhost:3001',
        publicFrontendUrl: 'http://localhost:5173',
        cookieSecure: false,
        fetchImpl: idpFetch,
      });
      const app = express();
      app.use(express.json());
      app.use('/api', createAuthRoutes(auth, (_req, _res, next) => next(), [oidc], true, { cookieSecure: false }));
      const server = app.listen(0);
      servers.push(server);
      await new Promise<void>((resolve) => server.once('listening', () => resolve()));
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

      await auth.createAccountWithStartingPassword('tom@acme.test', 'welcome-to-acme');
      await settings.save({ oidcIssuerUrl: ISSUER, oidcClientId: 'client-1', oidcClientSecret: 'secret-1' }, null);

      // Carol's account is made by signing in through the provider.
      const start = await fetch(`${base}/api/auth/oidc/login`, { redirect: 'manual' });
      const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
      const cookie = start.headers.get('set-cookie')!.split(';')[0];
      const cb = await fetch(`${base}/api/auth/oidc/callback?code=c&state=${state}`, {
        redirect: 'manual',
        headers: { cookie },
      });
      expect(cb.headers.get('location')).toContain('#token=');
      const before = await auth.listAccounts();
      const carol = before.find((a) => a.email === 'carol@example.com');
      expect(carol).toMatchObject({ hasPassword: false, deactivatedAt: null });

      await settings.save({ oidcIssuerUrl: null, oidcClientId: null, oidcClientSecret: null }, null);

      // The provider is gone from sign-in, read from the same database...
      expect(await (await fetch(`${base}/api/auth/providers`)).json()).toEqual({ password: true, sso: [] });
      // ...the account single sign-on created is still there, unchanged...
      const after = await auth.listAccounts();
      expect(after.find((a) => a.email === 'carol@example.com')).toEqual(carol);
      expect(after.map((a) => a.email).sort()).toEqual(before.map((a) => a.email).sort());
      // ...and password sign-in succeeds.
      const login = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'tom@acme.test', password: 'welcome-to-acme' }),
      });
      expect(login.status).toBe(200);
      expect(await login.json()).toMatchObject({ token: expect.any(String), user: { email: 'tom@acme.test' } });
    },
    PG_TEST_TIMEOUT,
  );
});
