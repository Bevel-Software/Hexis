import type { Server as HttpServer } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSecretsVaultRoutes } from '../secrets-vault.routes.js';
import type { ManagedSignInPort } from '../secrets-vault.contract.js';
import { testKbContext } from '../../../__tests__/kb-context.js';

/**
 * The routes' side of a MANAGED sign-in: a sign-in whose `oauth` block names
 * a connector goes through the distribution's port, unless an owner pinned
 * the deployment's own app; a workspace connection is a writer's to make;
 * and the Connect page is told what each row is. Stub services behind a
 * fake-auth middleware over a loopback server, as the connect-pending suite.
 */
type Deps = Parameters<typeof createSecretsVaultRoutes>[0];

const PERSONAL = {
  slug: 'microsoft365',
  name: 'microsoft365',
  path: 'Plugins/Sales/software.bevel.hexis/tools/microsoft365.tool',
  type: 'inline' as const,
  variables: [
    {
      name: 'ACCESS_TOKEN',
      scope: 'user' as const,
      label: 'Microsoft 365 sign-in',
      oauth: {
        authorizationUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
        tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
        scopes: ['Mail.Read'],
        managed: { connectorId: 'microsoft365', scopeSet: 'read' },
      },
    },
  ],
};
const SHARED = {
  ...PERSONAL,
  slug: 'hubspot',
  name: 'hubspot',
  path: 'Plugins/Sales/software.bevel.hexis/tools/hubspot.tool',
  variables: [
    {
      ...PERSONAL.variables[0],
      scope: 'admin' as const,
      label: 'HubSpot sign-in',
      oauth: { ...PERSONAL.variables[0].oauth, scopes: ['crm.objects.contacts.read'], managed: { connectorId: 'hubspot', scopeSet: 'read' } },
    },
  ],
};
const CARD = {
  displayName: 'Microsoft 365',
  icon: 'Mail',
  description: 'Lets Hexis read your mail.',
  permissions: ['Read your mail.'],
  scopeSetLabel: 'Read',
  dataResidency: 'EU',
  subprocessor: 'Microsoft',
};

/** A status row per key, with what each test says the vault holds. */
type Status = Partial<{
  userConfigured: boolean;
  userAuthorized: boolean;
  grantedScopes: string;
  userAccount: string;
  adminConfigured: boolean;
  adminKind: 'static' | 'oauth' | null;
  adminAuthorized: boolean;
  adminGrantedScopes: string;
  adminAccount: string;
  adminBringsOwnApp: boolean;
}>;

let httpServer: HttpServer | undefined;

async function serve(opts: {
  auth: { userId: string; email: string };
  manuals?: (typeof PERSONAL)[];
  status?: Status;
  canWrite?: boolean;
  port?: ManagedSignInPort | null;
}) {
  const manuals = opts.manuals ?? [PERSONAL];
  const status = opts.status ?? {};
  const beginToolOAuthByKey = vi.fn(async () => ({ id: 'row-1', url: 'https://provider.example/authorize?x=1' }));
  const secretsVault = {
    statusFor: async (_userId: string, keys: string[]) =>
      keys.map((key) => ({ key, adminConfigured: false, adminKind: null, userConfigured: false, userKind: null, ...status })),
    list: async () => [],
    beginToolOAuthByKey,
  } as unknown as Deps['secretsVault'];
  const toolManualService = {
    listAccessible: async () => manuals,
    listAccessibleCatalog: async () => ({ tools: manuals, invalid: [] }),
    liveDeclaration: async (_email: string, slug: string, varName: string) => {
      const manual = manuals.find((m) => m.slug === slug);
      const variable = manual?.variables.find((v) => v.name === varName);
      return manual ? { manual, variable } : null;
    },
  } as unknown as Deps['toolManualService'];
  const accessControl = {
    canWrite: async () => opts.canWrite ?? false,
    canRead: async () => true,
  } as unknown as Deps['accessControl'];
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.userId = opts.auth.userId;
    req.userEmail = opts.auth.email;
    next();
  });
  app.use(
    '/api',
    createSecretsVaultRoutes({
      kb: testKbContext(),
      secretsVault,
      toolManualService,
      accessControl,
      connectionProbe: { probe: async () => ({ status: 'unverifiable' as const, detail: null, checkedAt: new Date() }) },
      stateSecret: 'test-secret',
      publicBackendUrl: 'http://localhost:3000',
      publicFrontendUrl: 'http://localhost:5173',
      managedSignIns: () => (opts.port === undefined ? port : opts.port),
    }),
  );
  httpServer = await new Promise<HttpServer>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${(httpServer.address() as { port: number }).port}`;
  return { base, beginToolOAuthByKey };
}

/** The distribution's port, available and answering a URL. */
const start = vi.fn(async () => ({ url: 'https://connect.bevel.test/go?state=abc' }));
const port: ManagedSignInPort = {
  available: () => true,
  describe: () => CARD,
  start,
};
const unavailable: ManagedSignInPort = { ...port, available: () => false };

afterEach(async () => {
  start.mockClear();
  if (httpServer) await new Promise<void>((r) => httpServer!.close(() => r()));
  httpServer = undefined;
});

const startSignIn = (base: string, slug: string, body?: unknown) =>
  fetch(`${base}/api/secrets/tools/${slug}/vars/ACCESS_TOKEN/oauth/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe('POST /api/secrets/tools/:slug/vars/:var/oauth/start on a managed sign-in', () => {
  it('delegates a personal sign-in to the port, with the caller, the vault key and the return path', async () => {
    const { base, beginToolOAuthByKey } = await serve({ auth: { userId: 'u1', email: 'a@x.com' } });
    const res = await startSignIn(base, 'microsoft365', { returnTo: '/skills-and-tools/connect' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: 'https://connect.bevel.test/go?state=abc' });
    expect(start).toHaveBeenCalledWith({
      userId: 'u1',
      key: 'microsoft365_ACCESS_TOKEN',
      ref: { connectorId: 'microsoft365', scopeSet: 'read' },
      returnTo: '/skills-and-tools/connect',
    });
    expect(beginToolOAuthByKey).not.toHaveBeenCalled();
  });

  it('falls back to /connect for an unsafe return path', async () => {
    const { base } = await serve({ auth: { userId: 'u1', email: 'a@x.com' } });
    await startSignIn(base, 'microsoft365', { returnTo: 'https://evil.example/' });
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ returnTo: '/connect' }));
  });

  it('answers 409 when no broker is reachable, and when no port is wired at all', async () => {
    const { base } = await serve({ auth: { userId: 'u1', email: 'a@x.com' }, port: unavailable });
    const res = await startSignIn(base, 'microsoft365');
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/not connected to a connector broker/);
    expect(start).not.toHaveBeenCalled();
    const none = await serve({ auth: { userId: 'u1', email: 'a@x.com' }, port: null });
    expect((await startSignIn(none.base, 'microsoft365')).status).toBe(409);
  });

  it('a workspace connection: a reader is refused with 403, a writer opens it for the workspace (no person)', async () => {
    const reader = await serve({ auth: { userId: 'u1', email: 'a@x.com' }, manuals: [SHARED], canWrite: false });
    expect((await startSignIn(reader.base, 'hubspot')).status).toBe(403);
    expect(start).not.toHaveBeenCalled();
    await new Promise<void>((r) => httpServer!.close(() => r()));
    const writer = await serve({ auth: { userId: 'u1', email: 'a@x.com' }, manuals: [SHARED], canWrite: true });
    expect((await startSignIn(writer.base, 'hubspot')).status).toBe(200);
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ userId: null, key: 'hubspot_ACCESS_TOKEN', ref: { connectorId: 'hubspot', scopeSet: 'read' } }));
  });

  it('an owner’s own app on a personal sign-in runs the ordinary flow, not the port', async () => {
    const { base, beginToolOAuthByKey } = await serve({
      auth: { userId: 'u1', email: 'a@x.com' },
      status: { adminConfigured: true, adminKind: 'oauth', adminBringsOwnApp: true },
    });
    const res = await startSignIn(base, 'microsoft365');
    expect(res.status).toBe(200);
    expect(start).not.toHaveBeenCalled();
    expect(beginToolOAuthByKey).toHaveBeenCalledTimes(1);
    const url = new URL(((await res.json()) as { url: string }).url);
    expect(url.origin).toBe('https://provider.example');
    expect(url.searchParams.get('state')).toMatch(/\./);
  });

  it('an owner’s own app on a workspace connection is refused with 422: its tokens would land where nobody reads', async () => {
    const { base, beginToolOAuthByKey } = await serve({
      auth: { userId: 'u1', email: 'a@x.com' },
      manuals: [SHARED],
      canWrite: true,
      status: { adminConfigured: true, adminKind: 'oauth', adminBringsOwnApp: true },
    });
    const res = await startSignIn(base, 'hubspot');
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toMatch(/workspace connection cannot use your own OAuth app/);
    expect(start).not.toHaveBeenCalled();
    expect(beginToolOAuthByKey).not.toHaveBeenCalled();
  });

  it('a tool the caller cannot read is a 404, so a managed sign-in is never started through a name alone', async () => {
    const { base } = await serve({ auth: { userId: 'u1', email: 'a@x.com' }, manuals: [] });
    expect((await startSignIn(base, 'microsoft365')).status).toBe(404);
    expect(start).not.toHaveBeenCalled();
  });
});

interface PendingRow {
  slug: string;
  authorized: boolean;
  needsReauth: boolean;
  ownerConfigured: boolean;
  ownerOnly: boolean;
  canWrite?: boolean;
  managed?: { connectorId: string; tokenScope: string; account: string | null; ownApp: boolean; available: boolean; displayName: string; permissions: string[] };
}

describe('GET /api/connect/pending with managed sign-ins', () => {
  const pending = async (base: string) =>
    ((await (await fetch(`${base}/api/connect/pending`)).json()) as { toolOAuth: PendingRow[] }).toolOAuth;

  it('carries the connector’s card from the port, and a personal sign-in is the caller’s own, broker or no broker', async () => {
    const { base } = await serve({ auth: { userId: 'u1', email: 'a@x.com' }, port: unavailable });
    const [row] = await pending(base);
    expect(row).toMatchObject({
      slug: 'microsoft365',
      authorized: false,
      ownerConfigured: false,
      ownerOnly: false,
      canWrite: false,
      managed: { connectorId: 'microsoft365', tokenScope: 'user', available: false, ownApp: false, displayName: 'Microsoft 365', permissions: ['Read your mail.'] },
    });
  });

  it('a stored token counts as configured while the broker is unreachable, with the account the sign-in named', async () => {
    const { base } = await serve({
      auth: { userId: 'u1', email: 'a@x.com' },
      port: unavailable,
      status: { userConfigured: true, userAuthorized: true, grantedScopes: 'Mail.Read', userAccount: 'alice@acme.example' },
    });
    const [row] = await pending(base);
    expect(row).toMatchObject({ authorized: true, needsReauth: false, ownerConfigured: true, managed: { account: 'alice@acme.example' } });
  });

  it('a workspace connection is listed for a reader as the owner’s to make, and for a writer as theirs', async () => {
    const reader = await serve({ auth: { userId: 'u1', email: 'a@x.com' }, manuals: [SHARED], canWrite: false, status: { adminAuthorized: false } });
    expect((await pending(reader.base))[0]).toMatchObject({ slug: 'hubspot', ownerOnly: true, canWrite: false, managed: { tokenScope: 'shared' } });
    await new Promise<void>((r) => httpServer!.close(() => r()));
    const writer = await serve({
      auth: { userId: 'u1', email: 'a@x.com' },
      manuals: [SHARED],
      canWrite: true,
      status: { adminConfigured: true, adminKind: 'oauth', adminAuthorized: true, adminGrantedScopes: 'crm.objects.contacts.read', adminAccount: 'acme.hubspot.com' },
    });
    expect((await pending(writer.base))[0]).toMatchObject({ ownerOnly: false, canWrite: true, authorized: true, managed: { account: 'acme.hubspot.com' } });
  });

  it('without a port the card is bare and the sign-in is listed as waiting on the deployment', async () => {
    const { base } = await serve({ auth: { userId: 'u1', email: 'a@x.com' }, port: null });
    const [row] = await pending(base);
    expect(row.managed).toMatchObject({ displayName: 'Microsoft 365 sign-in', available: false, permissions: [] });
    expect(row.ownerConfigured).toBe(false);
  });
});

describe('GET /api/secrets/tools with a managed sign-in', () => {
  it('reports the owner row’s kind beside the managed card', async () => {
    const { base } = await serve({
      auth: { userId: 'u1', email: 'a@x.com' },
      status: { adminConfigured: true, adminKind: 'static' },
    });
    const body = (await (await fetch(`${base}/api/secrets/tools`)).json()) as {
      tools: { variables: { adminConfigured: boolean; adminKind: string | null; managed?: { connectorId: string } }[] }[];
    };
    expect(body.tools[0].variables[0]).toMatchObject({ adminConfigured: true, adminKind: 'static', managed: { connectorId: 'microsoft365' } });
  });
});
