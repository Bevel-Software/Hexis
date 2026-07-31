import type { Server as HttpServer } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { createSecretsVaultRoutes } from '../secrets-vault.routes.js';

/**
 * The aggregated `/connect/pending` surface: only the caller's PER-USER items
 * (never admin/shared), plus their OAuth secrets. Exercised with stub services
 * behind a fake-auth middleware over a real loopback server (no DB / JWT), the
 * same lightweight harness style the MCP proxy tests use.
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
      userConfigured: key === 'weather_API_KEY', // one set, the other not
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
      secretsVault,
      toolManualService,
      accessControl,
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

describe('GET /api/connect/pending', () => {
  it('returns only the caller’s per-user items with set/not-set, plus OAuth secrets', async () => {
    const base = await baseUrlWith({ userId: 'u1', email: 'a@x.com' });
    const res = await fetch(`${base}/api/connect/pending`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tools: { slug: string; variables: { name: string; configured: boolean }[] }[];
      oauth: { id: string; key: string; label: string | null; authorized: boolean }[];
    };

    // The admin-scoped SHARED_KEY must NOT appear — only the two user vars.
    const tool = body.tools.find((t) => t.slug === 'weather')!;
    expect(tool.variables.map((v) => v.name).sort()).toEqual(['API_KEY', 'USER_TOKEN']);
    const byName = Object.fromEntries(tool.variables.map((v) => [v.name, v.configured]));
    expect(byName.API_KEY).toBe(true); // configured
    expect(byName.USER_TOKEN).toBe(false); // outstanding

    // OAuth secrets are surfaced with their authorized state (static ones filtered out).
    expect(body.oauth).toEqual([{ id: 'oauth-1', key: 'notion_NOTION_TOKEN', label: 'Notion', authorized: false }]);
  });

  it('401s an unauthenticated caller', async () => {
    const base = await baseUrlWith({});
    const res = await fetch(`${base}/api/connect/pending`);
    expect(res.status).toBe(401);
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
          userConfigured: true,
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
        secretsVault: vaultWithGranted(grantedScopes),
        toolManualService: oauthTool,
        accessControl,
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
        keys.map((key) => ({ key, adminConfigured: true, userConfigured: true, userAuthorized: true })),
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
        secretsVault: vault,
        toolManualService: oauthTool,
        accessControl,
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
