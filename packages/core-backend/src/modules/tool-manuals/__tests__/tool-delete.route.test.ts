import type { Server as HttpServer } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthUser } from '@bevel-software/platform-shared';
import { createToolManualsBrowserRoutes } from '../tool-manuals.routes.js';
import { ToolDeleteError, type ToolDeleteService } from '../tool-delete.service.js';
import type { IToolManualService } from '../tool-manuals.contract.js';

/**
 * `GET /api/tools/:slug/dependents` and `DELETE /api/tools/:slug` — the route
 * half: who is let through, and that the service's refusal reaches the client
 * with its own status and its own words (the dialog prints them).
 */

const USER: AuthUser = { id: 'u-1', email: 'owner@x.com', name: 'Ola' } as AuthUser;

let httpServer: HttpServer | undefined;

async function baseUrl(opts: {
  userId?: string;
  email?: string;
  service?: Partial<ToolDeleteService>;
  wired?: boolean;
}): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (opts.email) req.userEmail = opts.email;
    if (opts.userId) req.userId = opts.userId;
    next();
  });
  const toolManualService = {} as unknown as IToolManualService;
  app.use(
    '/api',
    createToolManualsBrowserRoutes(
      toolManualService,
      undefined,
      opts.wired === false
        ? undefined
        : {
            service: (opts.service ?? {}) as ToolDeleteService,
            getUser: async (id: string) => (id === USER.id ? USER : undefined),
          },
    ),
  );
  httpServer = await new Promise<HttpServer>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  return `http://127.0.0.1:${(httpServer.address() as { port: number }).port}`;
}

afterEach(async () => {
  if (httpServer) await new Promise<void>((r) => httpServer!.close(() => r()));
  httpServer = undefined;
  vi.restoreAllMocks();
});

describe('GET /api/tools/:slug/dependents', () => {
  it('answers what the service found for a signed-in owner', async () => {
    const dependents = vi.fn(async () => ({
      slug: 'weather',
      name: 'weather',
      source: 'manual' as const,
      plugin: { name: 'gtm', displayName: 'GTM' },
      skills: [{ name: 'forecast', path: 'Plugins/GTM/forecast' }],
      plugins: [],
      storedKeys: 1,
      signIns: 2,
    }));
    const base = await baseUrl({ email: USER.email, userId: USER.id, service: { dependents } as never });
    const res = await fetch(`${base}/api/tools/weather/dependents`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ skills: [{ name: 'forecast' }], storedKeys: 1, signIns: 2 });
    expect(dependents).toHaveBeenCalledWith(USER.email, 'weather');
  });

  it('refuses an unauthenticated caller', async () => {
    const base = await baseUrl({ service: { dependents: vi.fn() } as never });
    expect((await fetch(`${base}/api/tools/weather/dependents`)).status).toBe(401);
  });

  it("passes the service's own status and words through", async () => {
    const base = await baseUrl({
      email: USER.email,
      service: {
        dependents: vi.fn(async () => {
          throw new ToolDeleteError("Only the owners of this tool's plugin can delete it.", 403);
        }),
      } as never,
    });
    const res = await fetch(`${base}/api/tools/weather/dependents`);
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "Only the owners of this tool's plugin can delete it." });
  });
});

describe('DELETE /api/tools/:slug', () => {
  it('deletes as the resolved user and answers the plugin to return to', async () => {
    const deleteTool = vi.fn(async () => ({ plugin: 'gtm' }));
    const base = await baseUrl({ email: USER.email, userId: USER.id, service: { deleteTool } as never });
    const res = await fetch(`${base}/api/tools/weather`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ plugin: 'gtm' });
    expect(deleteTool).toHaveBeenCalledWith(USER, 'weather');
  });

  it('refuses when no session identifies the caller', async () => {
    const deleteTool = vi.fn();
    const base = await baseUrl({ email: USER.email, service: { deleteTool } as never });
    expect((await fetch(`${base}/api/tools/weather`, { method: 'DELETE' })).status).toBe(401);
    expect(deleteTool).not.toHaveBeenCalled();
  });

  it('maps a service refusal to its status', async () => {
    const base = await baseUrl({
      email: USER.email,
      userId: USER.id,
      service: {
        deleteTool: vi.fn(async () => {
          throw new ToolDeleteError('No such tool.', 404);
        }),
      } as never,
    });
    const res = await fetch(`${base}/api/tools/weather`, { method: 'DELETE' });
    expect(res.status).toBe(404);
  });

  it('is absent — not a 500 — on a deployment that does not wire the service', async () => {
    const base = await baseUrl({ email: USER.email, userId: USER.id, wired: false });
    expect((await fetch(`${base}/api/tools/weather`, { method: 'DELETE' })).status).toBe(404);
    expect((await fetch(`${base}/api/tools/weather/dependents`)).status).toBe(404);
  });
});
