import type { Server as HttpServer } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSecretsVaultRoutes } from '../secrets-vault.routes.js';

/**
 * THE OWNER GATE: a tool's shared (admin) secrets — plain values and OAuth
 * client secrets — are settable by whoever can WRITE that `.tool` FILE (its
 * frontmatter `write:`/`owner:` verbs + the access.md chain), and by no one
 * else. There is deliberately NO platform-role check here: a non-Admin who
 * manages a `.tool` configures it; an Admin who can't write the file doesn't.
 * The per-file resolution itself (frontmatter verbs on `.tool` files) is
 * covered in access-control.service.test.ts — this locks the route gate to
 * `canWrite(path)` so no role-based shortcut regresses it.
 */

const TOOL_PATH = 'Tools/weather.tool';
const WRITER = 'writer@x.com';
const READER = 'reader@x.com';

const toolManualService = {
  listAccessible: async () => [
    {
      slug: 'weather',
      name: 'weather',
      path: TOOL_PATH,
      type: 'mcp' as const,
      variables: [
        { name: 'SHARED_KEY', scope: 'admin' as const, label: 'Org key' },
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
  ],
} as unknown as Parameters<typeof createSecretsVaultRoutes>[0]['toolManualService'];

const putSharedStatic = vi.fn(async () => ({ id: 's1' }));
const putSharedOAuthClientSecret = vi.fn(async () => {});
const secretsVault = {
  putSharedStatic,
  putSharedOAuthClientSecret,
} as unknown as Parameters<typeof createSecretsVaultRoutes>[0]['secretsVault'];

// Per-FILE write: only WRITER may write THIS tool's path. No role concept at all.
const accessControl = {
  canRead: async () => true,
  canWrite: async (_ws: string, email: string, path: string) => email === WRITER && path === TOOL_PATH,
} as unknown as Parameters<typeof createSecretsVaultRoutes>[0]['accessControl'];

let httpServer: HttpServer | undefined;

async function baseUrlAs(email: string): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.userId = `id-${email}`;
    req.userEmail = email;
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
  putSharedStatic.mockClear();
  putSharedOAuthClientSecret.mockClear();
});

describe('tool owner gate — shared config requires WRITE on the `.tool` file', () => {
  it('a writer of the file sets the shared admin value', async () => {
    const base = await baseUrlAs(WRITER);
    const res = await fetch(`${base}/api/secrets/tools/weather/vars/SHARED_KEY/admin`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 'k-123' }),
    });
    expect(res.status).toBe(201);
    expect(putSharedStatic).toHaveBeenCalledWith(expect.objectContaining({ key: 'weather_SHARED_KEY' }));
  });

  it('a non-writer is refused (403), even though they can READ the tool', async () => {
    const base = await baseUrlAs(READER);
    const res = await fetch(`${base}/api/secrets/tools/weather/vars/SHARED_KEY/admin`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 'k-123' }),
    });
    expect(res.status).toBe(403);
    expect(putSharedStatic).not.toHaveBeenCalled();
  });

  it('a writer of the file sets the OAuth client secret, pinned to the declared provider', async () => {
    const base = await baseUrlAs(WRITER);
    const res = await fetch(`${base}/api/secrets/tools/weather/vars/SIGNIN/oauth/admin`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientSecret: 'cs-123' }),
    });
    expect(res.status).toBe(201);
    expect(putSharedOAuthClientSecret).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'weather_SIGNIN',
        clientSecret: 'cs-123',
        provider: expect.objectContaining({ clientId: 'client-1' }),
      }),
    );
  });

  it('a non-writer cannot set the client secret (403)', async () => {
    const base = await baseUrlAs(READER);
    const res = await fetch(`${base}/api/secrets/tools/weather/vars/SIGNIN/oauth/admin`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientSecret: 'cs-123' }),
    });
    expect(res.status).toBe(403);
    expect(putSharedOAuthClientSecret).not.toHaveBeenCalled();
  });
});
