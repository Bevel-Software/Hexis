import type { Server as HttpServer } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { createSecretsVaultRoutes } from '../secrets-vault.routes.js';
import { testKbContext } from '../../../__tests__/kb-context.js';

/**
 * The aggregated `/connect/pending` surface: everything standing between the
 * caller and the tools they can READ — their own keys and sign-ins, and the
 * workspace values somebody else may have to set — plus their OAuth secrets.
 * Exercised with stub services behind a fake-auth middleware over a real
 * loopback server (no DB / JWT), the same lightweight harness style the MCP
 * proxy tests use.
 *
 * The admin tier is here because the Library's plugin banner counts an
 * integration waiting on one, and the page this feeds is where that banner
 * sends people. What the tier does NOT do is widen who sees what: every item
 * still comes from `listAccessible`.
 */

// One tool with a mix of scopes; one of its user vars is set, one isn't.
const toolManualService = {
  listAccessible: async () => [
    {
      slug: 'weather',
      name: 'weather',
      path: 'Tools/weather.tool',
      type: 'http' as const,
      variables: [
        { name: 'API_KEY', scope: 'user' as const, label: 'Weather API key' },
        { name: 'USER_TOKEN', scope: 'user' as const, label: null },
        { name: 'SHARED_KEY', scope: 'admin' as const, label: 'Org key' },
      ],
    },
  ],
} as unknown as Parameters<typeof createSecretsVaultRoutes>[0]['toolManualService'];

const secretsVault = {
  statusFor: async (_userId: string, keys: string[]) =>
    keys.map((key) => ({
      key,
      adminConfigured: false,
      adminKind: null,
      userConfigured: key === 'weather_API_KEY', // one set, the other not
      // The kind the row is really stored as — the vault reports it, and
      // `/connect/pending` only calls a variable configured when the row backs
      // the shape the manual declares. These are plain keys, so: static.
      userKind: key === 'weather_API_KEY' ? ('static' as const) : null,
    })),
  list: async () => [
    {
      id: 'oauth-1',
      key: 'notion_NOTION_TOKEN',
      kind: 'oauth' as const,
      label: 'Notion',
      authorized: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: 'static-1',
      key: 'weather_API_KEY',
      kind: 'static' as const,
      label: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ],
} as unknown as Parameters<typeof createSecretsVaultRoutes>[0]['secretsVault'];

const accessControl = {
  canWrite: async () => false,
  canRead: async () => true,
} as unknown as Parameters<typeof createSecretsVaultRoutes>[0]['accessControl'];

let httpServer: HttpServer | undefined;

async function baseUrlWith(auth: { userId?: string; email?: string }): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (auth.userId) req.userId = auth.userId;
    if (auth.email) req.userEmail = auth.email;
    next();
  });
  app.use(
    '/api',
    createSecretsVaultRoutes({
      kb: testKbContext(),
      secretsVault,
      toolManualService,
      accessControl,
      // These tests are about the credential write, not the probe.
      connectionProbe: {
        probe: async () => ({ status: 'unverifiable' as const, detail: null, checkedAt: new Date() }),
      },
      stateSecret: 'test-secret',
      publicBackendUrl: 'http://localhost:3000',
      publicFrontendUrl: 'http://localhost:5173',
    }),
  );
  httpServer = await new Promise<HttpServer>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = (httpServer.address() as { port: number }).port;
  return `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  if (httpServer) await new Promise<void>((r) => httpServer!.close(() => r()));
  httpServer = undefined;
});

interface PendingBody {
  tools: {
    slug: string;
    canWrite: boolean;
    variables: { name: string; scope: string; configured: boolean; ownerOnly: boolean }[];
  }[];
  oauth: { id: string; key: string; label: string | null; authorized: boolean }[];
}

describe('GET /api/connect/pending', () => {
  it('returns the caller’s own items AND the workspace ones, set/not-set', async () => {
    const base = await baseUrlWith({ userId: 'u1', email: 'a@x.com' });
    const res = await fetch(`${base}/api/connect/pending`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as PendingBody;

    // All three: the admin-scoped SHARED_KEY is unset, so it is outstanding for
    // somebody — and the banner that links here counts the tool for it.
    const tool = body.tools.find((t) => t.slug === 'weather')!;
    expect(tool.variables.map((v) => v.name).sort()).toEqual([
      'API_KEY',
      'SHARED_KEY',
      'USER_TOKEN',
    ]);
    const byName = Object.fromEntries(tool.variables.map((v) => [v.name, v]));
    expect(byName.API_KEY.configured).toBe(true); // configured
    expect(byName.USER_TOKEN.configured).toBe(false); // outstanding
    // This caller cannot write the `.tool`, so the shared one is not theirs to set.
    expect(tool.canWrite).toBe(false);
    expect(byName.SHARED_KEY).toMatchObject({ scope: 'admin', configured: false, ownerOnly: true });
    // …and their own vars are never owner-only, whatever they may write.
    expect(byName.API_KEY.ownerOnly).toBe(false);
    expect(byName.USER_TOKEN.ownerOnly).toBe(false);

    // OAuth secrets are surfaced with their authorized state (static ones filtered out).
    expect(body.oauth).toEqual([{ id: 'oauth-1', key: 'notion_NOTION_TOKEN', label: 'Notion', authorized: false }]);
  });

  it('401s an unauthenticated caller', async () => {
    const base = await baseUrlWith({});
    const res = await fetch(`${base}/api/connect/pending`);
    expect(res.status).toBe(401);
  });
});

describe('GET /api/connect/pending — the workspace tier', () => {
  /** The same one tool, with the caller's write verdict and the vault's answers dialled. */
  async function pendingFor(opts: {
    canWrite: boolean;
    adminConfigured?: boolean;
  }): Promise<PendingBody> {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.userId = 'u1';
      req.userEmail = 'a@x.com';
      next();
    });
    app.use(
      '/api',
      createSecretsVaultRoutes({
      kb: testKbContext(),
        secretsVault: {
          statusFor: async (_u: string, keys: string[]) =>
            keys.map((key) => ({
              key,
              adminConfigured: opts.adminConfigured ?? false,
              adminKind: opts.adminConfigured ? ('static' as const) : null,
              userConfigured: false,
              userKind: null,
            })),
          list: async () => [],
        } as unknown as Parameters<typeof createSecretsVaultRoutes>[0]['secretsVault'],
        toolManualService: {
          listAccessible: async () => [
            {
              slug: 'salesforce',
              name: 'salesforce',
              path: 'Plugins/GTM/salesforce.tool',
              type: 'http' as const,
              variables: [{ name: 'ORG_TOKEN', scope: 'admin' as const, label: null }],
            },
          ],
        } as unknown as Parameters<typeof createSecretsVaultRoutes>[0]['toolManualService'],
        accessControl: {
          canWrite: async () => opts.canWrite,
          canRead: async () => true,
        } as unknown as Parameters<typeof createSecretsVaultRoutes>[0]['accessControl'],
        connectionProbe: {
          probe: async () => ({ status: 'unverifiable' as const, detail: null, checkedAt: new Date() }),
        },
        stateSecret: 'test-secret',
        publicBackendUrl: 'http://localhost:3000',
        publicFrontendUrl: 'http://localhost:5173',
      }),
    );
    httpServer = await new Promise<HttpServer>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const port = (httpServer.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/api/connect/pending`);
    // An error body parses as JSON too, and `body.tools` would then be undefined
    // — a confusing crash where the tests below mean to read a verdict.
    expect(res.status).toBe(200);
    return (await res.json()) as PendingBody;
  }

  it('flags an unset workspace key the caller cannot write', async () => {
    const body = await pendingFor({ canWrite: false });
    const tool = body.tools.find((t) => t.slug === 'salesforce')!;
    expect(tool.canWrite).toBe(false);
    expect(tool.variables).toEqual([
      expect.objectContaining({ name: 'ORG_TOKEN', scope: 'admin', ownerOnly: true }),
    ]);
  });

  it('gives the OWNER the same key as an ordinary one to set', async () => {
    const body = await pendingFor({ canWrite: true });
    const tool = body.tools.find((t) => t.slug === 'salesforce')!;
    expect(tool.canWrite).toBe(true);
    expect(tool.variables[0].ownerOnly).toBe(false);
  });

  it('drops a workspace key that is already set — outstanding for nobody', async () => {
    // And with nothing left, the tool itself drops out: an integration that
    // needs no one is not on a page about what needs someone, and the banner
    // does not count it either.
    const body = await pendingFor({ canWrite: false, adminConfigured: true });
    expect(body.tools).toEqual([]);
  });
});

describe('GET /api/connect/pending — readability', () => {
  /**
   * A catalog that really withholds: `blackbox` exists, needs a workspace key,
   * and only `owner@x.com` may read it. The workspace tier is exactly the kind
   * of addition that could leak a name — the item is listed for the benefit of
   * people who cannot act on it — so the gate is asserted from both sides.
   */
  async function listingFor(email: string): Promise<PendingBody> {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.userId = 'u1';
      req.userEmail = email;
      next();
    });
    app.use(
      '/api',
      createSecretsVaultRoutes({
      kb: testKbContext(),
        secretsVault: {
          statusFor: async (_u: string, keys: string[]) =>
            keys.map((key) => ({
              key,
              adminConfigured: false,
              adminKind: null,
              userConfigured: false,
              userKind: null,
            })),
          list: async () => [],
        } as unknown as Parameters<typeof createSecretsVaultRoutes>[0]['secretsVault'],
        toolManualService: {
          listAccessible: async (who: string) =>
            [
              {
                slug: 'weather',
                name: 'weather',
                path: 'Tools/weather.tool',
                type: 'http' as const,
                variables: [{ name: 'API_KEY', scope: 'user' as const, label: null }],
              },
              {
                slug: 'blackbox',
                name: 'blackbox',
                path: 'Tools/blackbox.tool',
                type: 'http' as const,
                variables: [{ name: 'ORG_TOKEN', scope: 'admin' as const, label: null }],
              },
            ].filter((m) => m.slug !== 'blackbox' || who === 'owner@x.com'),
        } as unknown as Parameters<typeof createSecretsVaultRoutes>[0]['toolManualService'],
        accessControl,
        connectionProbe: {
          probe: async () => ({ status: 'unverifiable' as const, detail: null, checkedAt: new Date() }),
        },
        stateSecret: 'test-secret',
        publicBackendUrl: 'http://localhost:3000',
        publicFrontendUrl: 'http://localhost:5173',
      }),
    );
    httpServer = await new Promise<HttpServer>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const port = (httpServer.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/api/connect/pending`);
    // Asserted here, once, for every caller of this helper: a 500 body would
    // otherwise sail through the assertions below as "the tool is not listed",
    // which is the one wrong answer that looks like the right one.
    expect(res.status).toBe(200);
    return (await res.json()) as PendingBody;
  }

  it('never names a tool the caller cannot read, in any state', async () => {
    const body = await listingFor('a@x.com');
    // The parsed listing, not the raw text: `expect(raw).not.toContain(…)` also
    // passes when `tools` moved, emptied or errored, and the contract under test
    // is what the client reads off the payload.
    expect(body.tools.map((t) => t.slug)).toEqual(['weather']);
  });

  it('lists it, owner-only, for somebody who can read it', async () => {
    // The previous test would also pass if the route had simply dropped every
    // owner-only item; this is what says it did not.
    const body = await listingFor('owner@x.com');
    const blackbox = body.tools.find((t) => t.slug === 'blackbox');
    expect(blackbox).toBeDefined();
    expect(blackbox!.variables).toEqual([
      expect.objectContaining({ name: 'ORG_TOKEN', scope: 'admin', ownerOnly: true }),
    ]);
    // …and `ownerOnly` is a verdict, not a constant: the readable tool this
    // caller CAN act on is listed in the same payload without it.
    expect(body.tools.find((t) => t.slug === 'weather')!.variables[0].ownerOnly).toBe(false);
  });
});

describe('GET /api/connect/pending — OAuth scope coverage', () => {
  // A tool with an OAuth-backed var that now requires two scopes.
  const oauthTool = {
    listAccessible: async () => [
      {
        slug: 'google',
        name: 'google',
        path: 'Tools/google.tool',
        type: 'inline' as const,
        variables: [
          {
            name: 'GOOGLE_TOKEN',
            scope: 'user' as const,
            label: 'Google',
            oauth: {
              authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
              tokenUrl: 'https://oauth2.googleapis.com/token',
              clientId: 'cid',
              scopes: ['openid', 'https://www.googleapis.com/auth/calendar.readonly'],
            },
          },
        ],
      },
    ],
  } as unknown as Parameters<typeof createSecretsVaultRoutes>[0]['toolManualService'];

  const vaultWithGranted = (grantedScopes?: string) =>
    ({
      statusFor: async (_userId: string, keys: string[]) =>
        keys.map((key) => ({
          key,
          adminConfigured: false,
          adminKind: null,
          userConfigured: true,
          userKind: 'oauth' as const,
          userAuthorized: true,
          grantedScopes,
        })),
      list: async () => [],
    }) as unknown as Parameters<typeof createSecretsVaultRoutes>[0]['secretsVault'];

  async function pendingWith(grantedScopes?: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.userId = 'u1';
      req.userEmail = 'a@x.com';
      next();
    });
    app.use(
      '/api',
      createSecretsVaultRoutes({
      kb: testKbContext(),
        secretsVault: vaultWithGranted(grantedScopes),
        toolManualService: oauthTool,
        accessControl,
        // These tests are about the credential write, not the probe.
        connectionProbe: {
          probe: async () => ({ status: 'unverifiable' as const, detail: null, checkedAt: new Date() }),
        },
        stateSecret: 'test-secret',
        publicBackendUrl: 'http://localhost:3000',
        publicFrontendUrl: 'http://localhost:5173',
      }),
    );
    httpServer = await new Promise<HttpServer>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const port = (httpServer.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/api/connect/pending`);
    return (await res.json()) as {
      toolOAuth: { key: string; authorized: boolean; needsReauth: boolean }[];
    };
  }

  it('flags needsReauth when the token’s granted scopes under-cover the tool', async () => {
    const body = await pendingWith('openid'); // missing calendar.readonly
    const item = body.toolOAuth.find((o) => o.key === 'google_GOOGLE_TOKEN')!;
    expect(item.authorized).toBe(true);
    expect(item.needsReauth).toBe(true);
  });

  it('does not flag needsReauth when the token covers every required scope', async () => {
    const body = await pendingWith('openid https://www.googleapis.com/auth/calendar.readonly');
    const item = body.toolOAuth.find((o) => o.key === 'google_GOOGLE_TOKEN')!;
    expect(item.authorized).toBe(true);
    expect(item.needsReauth).toBe(false);
  });

  it('flags needsReauth when granted scopes are unknown (legacy token)', async () => {
    const body = await pendingWith(undefined);
    const item = body.toolOAuth.find((o) => o.key === 'google_GOOGLE_TOKEN')!;
    expect(item.needsReauth).toBe(true);
  });
});

describe('GET /api/connect/pending — tool sign-ins are not double-listed as standalone secrets', () => {
  it('excludes a tool-var-keyed oauth row from the standalone list', async () => {
    // Authorizing a tool sign-in provisions a per-user oauth row under the
    // tool-var key — it must render ONCE (as toolOAuth), not again as a
    // "standalone" secret. A genuinely standalone secret still shows.
    const oauthTool = {
      listAccessible: async () => [
        {
          slug: 'notion',
          name: 'notion',
          path: 'Tools/notion.tool',
          type: 'mcp' as const,
          variables: [
            {
              name: 'MCP_OAUTH',
              scope: 'user' as const,
              label: 'notion sign-in',
              oauth: { authorizationUrl: 'https://a.example/auth', tokenUrl: 'https://a.example/token', clientId: 'cid' },
            },
          ],
        },
      ],
    } as unknown as Parameters<typeof createSecretsVaultRoutes>[0]['toolManualService'];
    const vault = {
      statusFor: async (_u: string, keys: string[]) =>
        keys.map((key) => ({
          key,
          adminConfigured: true,
          adminKind: 'oauth' as const, // the provider registration, as the flow needs it
          userConfigured: true,
          userKind: 'oauth' as const,
          userAuthorized: true,
        })),
      list: async () => [
        // The provisioned per-user row for the TOOL sign-in — must be excluded.
        { id: 's-tool', key: 'notion_MCP_OAUTH', kind: 'oauth' as const, label: 'notion sign-in', authorized: true, createdAt: new Date(), updatedAt: new Date() },
        // A directly-registered secret — must stay.
        { id: 's-own', key: 'MY_TOKEN', kind: 'oauth' as const, label: 'Mine', authorized: false, createdAt: new Date(), updatedAt: new Date() },
      ],
    } as unknown as Parameters<typeof createSecretsVaultRoutes>[0]['secretsVault'];

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.userId = 'u1';
      req.userEmail = 'a@x.com';
      next();
    });
    app.use(
      '/api',
      createSecretsVaultRoutes({
      kb: testKbContext(),
        secretsVault: vault,
        toolManualService: oauthTool,
        accessControl,
        // These tests are about the credential write, not the probe.
        connectionProbe: {
          probe: async () => ({ status: 'unverifiable' as const, detail: null, checkedAt: new Date() }),
        },
        stateSecret: 'test-secret',
        publicBackendUrl: 'http://localhost:3000',
        publicFrontendUrl: 'http://localhost:5173',
      }),
    );
    httpServer = await new Promise<HttpServer>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const port = (httpServer.address() as { port: number }).port;
    const body = (await (await fetch(`http://127.0.0.1:${port}/api/connect/pending`)).json()) as {
      oauth: { id: string }[];
      toolOAuth: { key: string }[];
    };

    expect(body.toolOAuth.map((o) => o.key)).toEqual(['notion_MCP_OAUTH']);
    expect(body.oauth.map((o) => o.id)).toEqual(['s-own']);
  });
});

describe('GET /api/connect/pending — a row of the wrong KIND is not "set up"', () => {
  /**
   * A `.tool` can be edited to turn a plain shared key into an OAuth variable,
   * or back, and the row set for the previous shape outlives the edit. The two
   * are not interchangeable — `beginToolOAuthByKey` refuses a `static` shared
   * row outright — so "a row exists" must not be reported as "configured", or
   * the page offers an Authorize that cannot open and a key that nobody set
   * disappears from the list of what is missing.
   */
  type Status = {
    key: string;
    adminConfigured: boolean;
    adminKind: 'static' | 'oauth' | null;
    userConfigured: boolean;
    userKind: 'static' | 'oauth' | null;
  };

  async function pendingWith(opts: {
    variables: unknown[];
    status: (key: string) => Status;
  }): Promise<{
    tools: { slug: string; variables: { name: string; configured: boolean }[] }[];
    toolOAuth: { varName: string; ownerConfigured: boolean; ownerOnly: boolean }[];
  }> {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.userId = 'u1';
      req.userEmail = 'a@x.com';
      next();
    });
    app.use(
      '/api',
      createSecretsVaultRoutes({
      kb: testKbContext(),
        secretsVault: {
          statusFor: async (_u: string, keys: string[]) => keys.map(opts.status),
          list: async () => [],
        } as unknown as Parameters<typeof createSecretsVaultRoutes>[0]['secretsVault'],
        toolManualService: {
          listAccessible: async () => [
            {
              slug: 'google',
              name: 'google',
              path: 'Tools/google.tool',
              type: 'inline' as const,
              variables: opts.variables,
            },
          ],
        } as unknown as Parameters<typeof createSecretsVaultRoutes>[0]['toolManualService'],
        accessControl,
        connectionProbe: {
          probe: async () => ({ status: 'unverifiable' as const, detail: null, checkedAt: new Date() }),
        },
        stateSecret: 'test-secret',
        publicBackendUrl: 'http://localhost:3000',
        publicFrontendUrl: 'http://localhost:5173',
      }),
    );
    httpServer = await new Promise<HttpServer>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const port = (httpServer.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/api/connect/pending`);
    expect(res.status).toBe(200);
    return (await res.json()) as Awaited<ReturnType<typeof pendingWith>>;
  }

  const oauthVar = [
    {
      name: 'GOOGLE_TOKEN',
      scope: 'user' as const,
      label: 'Google',
      oauth: {
        authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        tokenUrl: 'https://oauth2.googleapis.com/token',
        clientId: 'cid',
      },
    },
  ];

  it('does not call an OAuth var registered when the shared row is a leftover static key', async () => {
    const body = await pendingWith({
      variables: oauthVar,
      status: (key) => ({
        key,
        adminConfigured: true, // a row is there…
        adminKind: 'static', // …but it is the key from before this var was OAuth
        userConfigured: false,
        userKind: null,
      }),
    });
    const signIn = body.toolOAuth.find((o) => o.varName === 'GOOGLE_TOKEN')!;
    // No consent screen exists behind that row, so the page must show the
    // owner's job, not an Authorize the flow would reject.
    expect(signIn.ownerConfigured).toBe(false);
    expect(signIn.ownerOnly).toBe(true); // this caller cannot write the `.tool`
  });

  it('calls it registered when the shared row is the OAuth one the flow reads', async () => {
    const body = await pendingWith({
      variables: oauthVar,
      status: (key) => ({
        key,
        adminConfigured: true,
        adminKind: 'oauth',
        userConfigured: false,
        userKind: null,
      }),
    });
    expect(body.toolOAuth.find((o) => o.varName === 'GOOGLE_TOKEN')!.ownerConfigured).toBe(true);
  });

  it('does not call a plain key configured when the caller’s row is a leftover OAuth one', async () => {
    const body = await pendingWith({
      variables: [{ name: 'API_KEY', scope: 'user' as const, label: null }],
      status: (key) => ({
        key,
        adminConfigured: false,
        adminKind: null,
        userConfigured: true, // a row is there…
        userKind: 'oauth', // …holding a token set, where this var wants a value
      }),
    });
    const apiKey = body.tools.find((t) => t.slug === 'google')!.variables[0];
    expect(apiKey.configured).toBe(false);
  });
});
