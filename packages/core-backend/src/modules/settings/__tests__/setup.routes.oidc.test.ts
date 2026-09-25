import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSetupRoutes } from '../setup.routes.js';
import { DeploymentSettingsService } from '../deployment-settings.service.js';
import type { IssuerCheck, OidcCheck, OidcConfiguration } from '../oidc-check.js';
import { OidcAuthProvider, oidcSettingsFrom } from '../../auth/oidc-auth-provider.js';
import type { AuthService } from '../../auth/auth.service.js';
import type { Database } from '../../database/connection.js';
import type { IAdminAccessService } from '../../admin/admin.interface.js';
import { testKbContext } from '../../../__tests__/kb-context.js';

const ENC_KEY = 'kToAi8FXWDpDn3A6yQ/60O39bv05N7XzVOIu/0CJrFc=';
const ISSUER = 'https://login.example.com/tenant/v2.0';
const REDIRECT = 'https://hexis.example.com/api/auth/oidc/callback';

/**
 * Cleared so `resolve` falls through to the stored layer, and restored after:
 * the repo `.env` is loaded into `process.env` for every suite in the worker.
 */
const ENV = [
  'KB_REPO_URL',
  'GIT_TOKEN',
  'GITHUB_TOKEN',
  'OIDC_ISSUER_URL',
  'OIDC_CLIENT_ID',
  'OIDC_CLIENT_SECRET',
  'OIDC_SCOPES',
  'OIDC_PROVIDER_LABEL',
  'ALLOWED_EMAIL_DOMAINS',
  // Parameterized below as a non-sign-in setting, which an env value would own.
  'KB_DIR_NAME',
] as const;
let savedEnv: Partial<Record<(typeof ENV)[number], string | undefined>> = {};
let server: HttpServer | null = null;

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  server?.close();
  server = null;
  for (const k of ENV) {
    const original = savedEnv[k];
    if (original === undefined) delete process.env[k];
    else process.env[k] = original;
  }
});

type Row = { key: string; value: string; encrypted: boolean };

/**
 * An in-memory table. Conditions are not evaluated — a select answers every
 * row, which the service narrows by key itself — and deletes are only counted.
 */
function memoryDb(rows: Row[] = [], deleted: string[][] = []) {
  const all = () => Promise.resolve(rows);
  return {
    select: () => ({ from: () => Object.assign(all(), { where: all }) }),
    insert: () => ({
      values: (row: Row) => ({
        onConflictDoUpdate: (conflict: { set: Pick<Row, 'value' | 'encrypted'> }) => {
          const existing = rows.find((r) => r.key === row.key);
          if (existing) Object.assign(existing, { value: conflict.set.value, encrypted: conflict.set.encrypted });
          else rows.push({ ...row });
          return Promise.resolve();
        },
        onConflictDoNothing: () => {
          if (!rows.some((r) => r.key === row.key)) rows.push({ ...row });
          return Promise.resolve();
        },
      }),
    }),
    delete: () => ({
      where: () => {
        deleted.push(rows.map((r) => r.key));
        return Promise.resolve();
      },
    }),
  } as unknown as Database;
}
const fakeDb = () => memoryDb();

/** Stands in for the provider: answers every check with `result` and records what was asked. */
function provider(result: OidcCheck) {
  const asked: OidcConfiguration[] = [];
  return {
    asked,
    check: async (config: OidcConfiguration) => {
      asked.push(config);
      return result;
    },
  };
}

function listen(opts: {
  checkOidc?: (config: OidcConfiguration) => Promise<OidcCheck>;
  checkIssuer?: (issuerUrl: string) => Promise<IssuerCheck>;
  isAdmin?: boolean;
  encKey?: string;
}) {
  const settings = new DeploymentSettingsService(fakeDb(), opts.encKey ?? ENC_KEY);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.userEmail = 'root@example.com';
    req.userId = 'user-1';
    next();
  });
  app.use(
    '/api',
    createSetupRoutes(
      settings,
      { isAdmin: async () => opts.isAdmin ?? true } as IAdminAccessService,
      { runAll: async () => {} },
      testKbContext(),
      undefined,
      // No repository in these suites, so the connection check is never reached.
      async () => {
        throw new Error('the repository connection must not be probed');
      },
      undefined,
      REDIRECT,
      opts.checkOidc,
      opts.checkIssuer,
    ),
  );
  server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, settings };
}

const post = (base: string, path: string, body: unknown) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const FULL = { oidcIssuerUrl: ISSUER, oidcClientId: 'app-id', oidcClientSecret: 'secret-1' };

describe('POST /setup/settings — a sign-in configuration is checked before it is stored', () => {
  it('refuses an issuer the check rejects, on the issuer field, and stores nothing', async () => {
    const idp = provider({
      outcome: 'rejected',
      reason: 'not-oidc',
      field: 'oidcIssuerUrl',
      error: 'That address is not a single sign-on provider.',
    });
    const { base, settings } = listen({ checkOidc: idp.check });
    const res = await post(base, '/api/setup/settings', { settings: FULL });
    expect(res.status).toBe(400);
    expect((await res.json()).problems).toEqual({
      oidcIssuerUrl: 'That address is not a single sign-on provider.',
    });
    expect(idp.asked).toEqual([
      { issuerUrl: ISSUER, clientId: 'app-id', clientSecret: 'secret-1', redirectUri: REDIRECT },
    ]);
    expect(settings.resolve('oidcIssuerUrl')).toBe('');
    expect(settings.resolve('oidcClientSecret')).toBe('');
    expect(await settings.oidcVerification()).toBe('not-configured');
  });

  it('refuses credentials the provider rejects, on the secret field, and stores nothing', async () => {
    const idp = provider({
      outcome: 'rejected',
      reason: 'credentials',
      field: 'oidcClientSecret',
      error: 'The provider rejected the application ID or secret.',
    });
    const { base, settings } = listen({ checkOidc: idp.check });
    const res = await post(base, '/api/setup/settings', { settings: FULL });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.problems).toEqual({ oidcClientSecret: 'The provider rejected the application ID or secret.' });
    expect(JSON.stringify(body)).not.toContain('secret-1');
    expect(settings.resolve('oidcClientId')).toBe('');
  });

  it('saves a configuration that could not be verified, and labels it Unverified', async () => {
    const idp = provider({ outcome: 'unverified', error: 'could not be verified' });
    const { base, settings } = listen({ checkOidc: idp.check });
    const res = await post(base, '/api/setup/settings', { settings: FULL });
    expect(res.status).toBe(200);
    expect((await res.json()).oidcVerification).toBe('unverified');
    expect(settings.resolve('oidcIssuerUrl')).toBe(ISSUER);
  });

  it('saves a verified configuration, and labels it Verified', async () => {
    const idp = provider({ outcome: 'verified' });
    const { base } = listen({ checkOidc: idp.check });
    const res = await post(base, '/api/setup/settings', { settings: FULL });
    expect(res.status).toBe(200);
    expect((await res.json()).oidcVerification).toBe('verified');
    const status = await (await fetch(`${base}/api/setup/status`)).json();
    expect(status.oidcVerification).toBe('verified');
  });

  it('checks a changed secret against the stored issuer and application id', async () => {
    const idp = provider({ outcome: 'verified' });
    const { base, settings } = listen({ checkOidc: idp.check });
    await settings.save(FULL, null);
    const res = await post(base, '/api/setup/settings', { settings: { oidcClientSecret: 'secret-2' } });
    expect(res.status).toBe(200);
    expect(idp.asked).toEqual([
      { issuerUrl: ISSUER, clientId: 'app-id', clientSecret: 'secret-2', redirectUri: REDIRECT },
    ]);
  });

  it('a changed secret the provider rejects leaves the stored one — and its verification — in place', async () => {
    const { base, settings } = listen({
      checkOidc: provider({
        outcome: 'rejected',
        reason: 'credentials',
        field: 'oidcClientSecret',
        error: 'The provider rejected the application ID or secret.',
      }).check,
    });
    await settings.save(FULL, null);
    await settings.recordOidcVerification('verified', settings.resolveOidcCredentials());
    const res = await post(base, '/api/setup/settings', { settings: { oidcClientSecret: 'typo' } });
    expect(res.status).toBe(400);
    expect(settings.resolve('oidcClientSecret')).toBe('secret-1');
    expect(await settings.oidcVerification()).toBe('verified');
  });

  it.each([
    ['the scopes', { oidcScopes: 'openid email' }],
    ['the button label', { oidcProviderLabel: 'Company SSO' }],
    ['the allowed domains', { allowedEmailDomains: 'example.com' }],
    ['a non-sign-in setting', { kbDirName: 'kb' }],
    ['the stored values sent back unchanged', { oidcIssuerUrl: `${ISSUER}/`, oidcClientId: 'app-id' }],
  ])('never probes a save that changes only %s, and the verification stands', async (_name, entries) => {
    const idp = provider({ outcome: 'unverified', error: 'x' });
    const { base, settings } = listen({ checkOidc: idp.check });
    await settings.save(FULL, null);
    await settings.recordOidcVerification('verified', settings.resolveOidcCredentials());
    const res = await post(base, '/api/setup/settings', { settings: entries });
    expect(res.status).toBe(200);
    expect(idp.asked).toEqual([]);
    expect((await res.json()).oidcVerification).toBe('verified');
  });

  it('does not probe until the issuer, application id and secret are all there', async () => {
    const idp = provider({ outcome: 'verified' });
    const { base } = listen({ checkOidc: idp.check });
    const res = await post(base, '/api/setup/settings', {
      settings: { oidcIssuerUrl: ISSUER, oidcClientId: 'app-id' },
    });
    expect(res.status).toBe(200);
    expect(idp.asked).toEqual([]);
    expect((await res.json()).oidcVerification).toBe('not-configured');
  });

  it('refuses a new issuer without a secret, and never sends the saved secret there', async () => {
    const idp = provider({ outcome: 'verified' });
    const { base, settings } = listen({ checkOidc: idp.check });
    await settings.save(FULL, null);
    const res = await post(base, '/api/setup/settings', {
      settings: { oidcIssuerUrl: 'https://attacker.example/issuer' },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).problems.oidcClientSecret).toMatch(/application secret for that provider/);
    expect(idp.asked).toEqual([]);
    expect(settings.resolve('oidcIssuerUrl')).toBe(ISSUER);
  });

  it('pairs an OIDC_CLIENT_SECRET with the first issuer saved — there was no provider it was set for yet', async () => {
    process.env.OIDC_CLIENT_SECRET = 'from-env';
    const idp = provider({ outcome: 'verified' });
    const { base, settings } = listen({ checkOidc: idp.check });
    const res = await post(base, '/api/setup/settings', {
      settings: { oidcIssuerUrl: ISSUER, oidcClientId: 'app-id' },
    });
    expect(res.status).toBe(200);
    expect(idp.asked).toEqual([
      { issuerUrl: ISSUER, clientId: 'app-id', clientSecret: 'from-env', redirectUri: REDIRECT },
    ]);
    expect(settings.resolve('oidcIssuerUrl')).toBe(ISSUER);
    expect((await res.json()).oidcVerification).toBe('verified');
  });

  it('still refuses a different issuer later, when the OIDC_CLIENT_SECRET was set for the first', async () => {
    process.env.OIDC_CLIENT_SECRET = 'from-env';
    const idp = provider({ outcome: 'verified' });
    const { base, settings } = listen({ checkOidc: idp.check });
    await settings.save({ oidcIssuerUrl: ISSUER, oidcClientId: 'app-id' }, null);
    const res = await post(base, '/api/setup/settings', {
      settings: { oidcIssuerUrl: 'https://attacker.example/issuer' },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).problems.oidcIssuerUrl).toMatch(/OIDC_CLIENT_SECRET environment variable/);
    expect(idp.asked).toEqual([]);
    expect(settings.resolve('oidcIssuerUrl')).toBe(ISSUER);
  });
});

describe('POST /setup/test-oidc', () => {
  it('checks the typed values and reports the outcome, without saving them', async () => {
    const idp = provider({ outcome: 'verified' });
    const { base, settings } = listen({ checkOidc: idp.check });
    const res = await post(base, '/api/setup/test-oidc', FULL);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, outcome: 'verified' });
    expect(idp.asked).toEqual([
      { issuerUrl: ISSUER, clientId: 'app-id', clientSecret: 'secret-1', redirectUri: REDIRECT },
    ]);
    expect(settings.resolve('oidcIssuerUrl')).toBe('');
  });

  it('reports a rejection as an answer, with its field, and never echoes the secret', async () => {
    const idp = provider({
      outcome: 'rejected',
      reason: 'credentials',
      field: 'oidcClientSecret',
      error: 'The provider rejected the application ID or secret.',
    });
    const { base } = listen({ checkOidc: idp.check });
    const res = await post(base, '/api/setup/test-oidc', FULL);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      ok: false,
      outcome: 'rejected',
      field: 'oidcClientSecret',
      error: 'The provider rejected the application ID or secret.',
    });
    expect(JSON.stringify(body)).not.toContain('secret-1');
  });

  it('reports "could not be verified" with its message', async () => {
    const { base } = listen({ checkOidc: provider({ outcome: 'unverified', error: 'no idea' }).check });
    expect(await (await post(base, '/api/setup/test-oidc', FULL)).json()).toMatchObject({
      ok: false,
      outcome: 'unverified',
      error: 'no idea',
    });
  });

  it('checks only the issuer when there are no credentials to try yet', async () => {
    const issuers: string[] = [];
    const idp = provider({ outcome: 'verified' });
    const { base } = listen({
      checkOidc: idp.check,
      checkIssuer: async (url) => {
        issuers.push(url);
        return { outcome: 'verified', tokenEndpoint: 'https://login.example.com/token' };
      },
    });
    const res = await post(base, '/api/setup/test-oidc', { oidcIssuerUrl: `${ISSUER}/` });
    expect(await res.json()).toEqual({ ok: true, outcome: 'issuer-verified' });
    expect(issuers).toEqual([ISSUER]);
    expect(idp.asked).toEqual([]);
  });

  it('refuses an issuer that is not https before any request (the real check)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { base } = listen({});
    fetchSpy.mockClear();
    const res = await fetch(`${base}/api/setup/test-oidc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...FULL, oidcIssuerUrl: 'http://login.example.com' }),
    });
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, outcome: 'rejected', field: 'oidcIssuerUrl' });
    // Only this test's own request went out — nothing to the provider.
    expect(fetchSpy.mock.calls.map(([url]) => String(url))).toEqual([`${base}/api/setup/test-oidc`]);
    fetchSpy.mockRestore();
  });

  it('tries an OIDC_CLIENT_SECRET with the first issuer typed, before any issuer is saved', async () => {
    process.env.OIDC_CLIENT_SECRET = 'from-env';
    const idp = provider({ outcome: 'verified' });
    const { base } = listen({ checkOidc: idp.check });
    const res = await post(base, '/api/setup/test-oidc', { oidcIssuerUrl: ISSUER, oidcClientId: 'app-id' });
    expect(await res.json()).toMatchObject({ ok: true, outcome: 'verified' });
    expect(idp.asked).toEqual([
      { issuerUrl: ISSUER, clientId: 'app-id', clientSecret: 'from-env', redirectUri: REDIRECT },
    ]);
  });

  it('refuses to send the saved secret to a different issuer', async () => {
    const idp = provider({ outcome: 'verified' });
    const { base, settings } = listen({ checkOidc: idp.check });
    await settings.save(FULL, null);
    const res = await post(base, '/api/setup/test-oidc', { oidcIssuerUrl: 'https://attacker.example' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/application secret for that provider/);
    expect(idp.asked).toEqual([]);
  });

  it('re-tests the saved configuration with the saved secret, and a pass marks it verified', async () => {
    const idp = provider({ outcome: 'verified' });
    const { base, settings } = listen({ checkOidc: idp.check });
    await settings.save(FULL, null);
    expect(await settings.oidcVerification()).toBe('unverified');
    const res = await post(base, '/api/setup/test-oidc', {});
    expect(await res.json()).toMatchObject({ ok: true, outcome: 'verified', oidcVerification: 'verified' });
    expect(idp.asked[0].clientSecret).toBe('secret-1');
  });

  it('is admins-only', async () => {
    const idp = provider({ outcome: 'verified' });
    const { base } = listen({ checkOidc: idp.check, isAdmin: false });
    expect((await post(base, '/api/setup/test-oidc', FULL)).status).toBe(403);
    expect(idp.asked).toEqual([]);
  });
});

describe('the verification state', () => {
  it('is never recorded without SECRETS_ENC_KEY — the digest would be an offline oracle on the secret', async () => {
    process.env.OIDC_ISSUER_URL = ISSUER;
    process.env.OIDC_CLIENT_ID = 'app-id';
    process.env.OIDC_CLIENT_SECRET = 'from-env';
    const rows: Row[] = [];
    const settings = new DeploymentSettingsService(memoryDb(rows), '');
    expect(await settings.oidcVerification()).toBe('unrecordable');
    await settings.recordOidcVerification('verified', settings.resolveOidcCredentials());
    expect(rows).toEqual([]);
    expect(await settings.oidcVerification()).toBe('unrecordable');
  });

  it('the check still runs without SECRETS_ENC_KEY, and the state says it cannot be recorded', async () => {
    process.env.OIDC_CLIENT_SECRET = 'from-env';
    const idp = provider({ outcome: 'verified' });
    const { base, settings } = listen({ checkOidc: idp.check, encKey: '' });
    await settings.save({ oidcIssuerUrl: ISSUER, oidcClientId: 'app-id' }, null);
    const res = await post(base, '/api/setup/test-oidc', {});
    expect(await res.json()).toMatchObject({ outcome: 'verified', oidcVerification: 'unrecordable' });
  });

  it('is not-configured, then unverified, then verified after a real sign-in', async () => {
    const settings = new DeploymentSettingsService(fakeDb(), ENC_KEY);
    expect(await settings.oidcVerification()).toBe('not-configured');
    await settings.save(FULL, null);
    expect(await settings.oidcVerification()).toBe('unverified');

    // The composition root's wiring: a sign-in through the provider reading
    // these settings records the values it used as verified.
    const idpFetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/.well-known/openid-configuration')) {
        return Response.json({
          authorization_endpoint: `${ISSUER}/authorize`,
          token_endpoint: `${ISSUER}/token`,
          userinfo_endpoint: `${ISSUER}/userinfo`,
        });
      }
      if (url === `${ISSUER}/token`) return Response.json({ access_token: 'at' });
      if (url === `${ISSUER}/userinfo`) return Response.json({ email: 'carol@example.com', name: 'Carol' });
      return new Response('', { status: 404 });
    }) as typeof fetch;
    const oidc = new OidcAuthProvider({
      settings: () => oidcSettingsFrom(settings),
      publicBackendUrl: 'http://localhost:3001',
      publicFrontendUrl: 'http://localhost:5173',
      cookieSecure: false,
      fetchImpl: idpFetch,
      onSignedIn: (used) => settings.recordOidcVerification('verified', used),
    });
    const router = express.Router();
    oidc.mountRoutes(router, {
      loginWithSso: async () => ({ token: 'jwt', user: {} }),
    } as unknown as AuthService);
    const app = express();
    app.use('/api', router);
    server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const start = await fetch(`${base}/api/auth/oidc/login`, { redirect: 'manual' });
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const cookie = start.headers.get('set-cookie')!.split(';')[0];
    await fetch(`${base}/api/auth/oidc/callback?code=c&state=${state}`, {
      redirect: 'manual',
      headers: { cookie },
    });

    expect(await settings.oidcVerification()).toBe('verified');
  });

  it('speaks only for the values it was made about', async () => {
    const settings = new DeploymentSettingsService(fakeDb(), ENC_KEY);
    await settings.save(FULL, null);
    await settings.recordOidcVerification('verified', settings.resolveOidcCredentials());
    expect(await settings.oidcVerification()).toBe('verified');
    // A different secret — here through the environment — is not the one proven.
    process.env.OIDC_CLIENT_SECRET = 'from-env';
    expect(await settings.oidcVerification()).toBe('unverified');
    delete process.env.OIDC_CLIENT_SECRET;
    expect(await settings.oidcVerification()).toBe('verified');
  });

  it('survives a reload, and prune keeps it', async () => {
    const rows: Row[] = [];
    const deleted: string[][] = [];
    const db = memoryDb(rows, deleted);
    const first = new DeploymentSettingsService(db, ENC_KEY);
    await first.save({ ...FULL, kbDirName: 'kb' }, null);
    await first.recordOidcVerification('verified', first.resolveOidcCredentials());
    // Nothing stored under a setting that this build no longer has — so prune
    // deletes nothing, the record included.
    await first.prune();
    expect(deleted).toEqual([]);
    const second = new DeploymentSettingsService(db, ENC_KEY);
    await second.load();
    expect(await second.oidcVerification()).toBe('verified');
    expect(second.describe().some((s) => s.key.startsWith('oidcVerification'))).toBe(false);
  });

  it('is read from the database, so a sign-in on one replica shows on another without a reload', async () => {
    const db = memoryDb();
    const signedInOn = new DeploymentSettingsService(db, ENC_KEY);
    const shownOn = new DeploymentSettingsService(db, ENC_KEY);
    await signedInOn.save(FULL, null);
    await shownOn.load();
    expect(await shownOn.oidcVerification()).toBe('unverified');
    await signedInOn.recordOidcVerification('verified', signedInOn.resolveOidcCredentials());
    expect(await shownOn.oidcVerification()).toBe('verified');
  });

  it('a sign-in finishing through a provider built from old values never overwrites the record of the new ones', async () => {
    const settings = new DeploymentSettingsService(memoryDb(), ENC_KEY);
    await settings.save(FULL, null);
    const old = settings.resolveOidcCredentials();
    await settings.save({ oidcClientSecret: 'secret-2' }, null);
    await settings.recordOidcVerification('verified', settings.resolveOidcCredentials());
    // The old provider's onSignedIn lands late.
    await settings.recordOidcVerification('verified', old);
    await settings.recordOidcVerification('unverified', old);
    expect(await settings.oidcVerification()).toBe('verified');
  });

  it('an inconclusive answer never downgrades values already proven', async () => {
    const settings = new DeploymentSettingsService(memoryDb(), ENC_KEY);
    await settings.save(FULL, null);
    const credentials = settings.resolveOidcCredentials();
    await settings.recordOidcVerification('unverified', credentials);
    expect(await settings.oidcVerification()).toBe('unverified');
    await settings.recordOidcVerification('verified', credentials);
    // An overlapping check that could not reach the token endpoint lands last.
    await settings.recordOidcVerification('unverified', credentials);
    expect(await settings.oidcVerification()).toBe('verified');
  });

  it('never mistakes one set of values for another that joins to the same text', async () => {
    const settings = new DeploymentSettingsService(memoryDb(), ENC_KEY);
    await settings.save({ oidcIssuerUrl: ISSUER, oidcClientId: 'app', oidcClientSecret: 'id\nsecret' }, null);
    await settings.recordOidcVerification('verified', { issuerUrl: ISSUER, clientId: 'app\nid', clientSecret: 'secret' });
    expect(await settings.oidcVerification()).toBe('unverified');
  });
});
