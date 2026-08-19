import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createUpdateCheckRoutes } from '../update-check.routes.js';
import type { UpdateCheckService } from '../update-check.service.js';

/**
 * GET /api/update-check — admin-only. Non-admins get the same 403 the setup
 * routes give (the frontend only asks on behalf of admins anyway), and the
 * service is never consulted for them.
 */

let server: HttpServer | null = null;

afterEach(() => {
  server?.close();
  server = null;
  vi.restoreAllMocks();
});

function listen(
  service: Pick<UpdateCheckService, 'check'>,
  opts: { email?: string; admins?: string[] } = {},
): string {
  const app = express();
  const middleware: express.RequestHandler = (req, _res, next) => {
    req.userEmail = opts.email ?? 'user@example.com';
    next();
  };
  const adminAccess = {
    isAdmin: async (email: string | undefined) =>
      (opts.admins ?? ['admin@example.com']).includes(email ?? ''),
  };
  app.use('/api', middleware, createUpdateCheckRoutes(service, adminAccess));
  server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

describe('GET /update-check', () => {
  it('answers the full shape for an admin', async () => {
    const check = vi.fn().mockResolvedValue({
      updateAvailable: true,
      current: '0.9.1',
      latest: '0.10.0',
      notesUrl: 'https://github.com/Bevel-Software/Hexis/releases/tag/v0.10.0',
    });
    const base = listen({ check }, { email: 'admin@example.com' });
    const res = await fetch(`${base}/api/update-check`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      updateAvailable: true,
      current: '0.9.1',
      latest: '0.10.0',
      notesUrl: 'https://github.com/Bevel-Software/Hexis/releases/tag/v0.10.0',
    });
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('403s a non-admin without consulting the service', async () => {
    const check = vi.fn();
    const base = listen({ check }, { email: 'user@example.com' });
    const res = await fetch(`${base}/api/update-check`);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Admins only' });
    expect(check).not.toHaveBeenCalled();
  });
});
