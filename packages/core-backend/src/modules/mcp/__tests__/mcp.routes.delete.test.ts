import type { Server as HttpServer } from 'node:http';
import type { RequestHandler } from 'express';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMcpRoutes } from '../mcp.routes.js';
import { TokenNotFoundError, TokenStillActiveError } from '../../tool-auth/external-api-key.errors.js';
import type { IExternalApiKeyService } from '../../tool-auth/external-api-key.interface.js';

/**
 * Focused coverage for the status mapping of
 *   DELETE /api/mcp/external-api-keys/:id/permanent
 * The MCP e2e test exercises transport/proxy behaviour but never this route, so
 * this locks down how the handler translates the service's error types into
 * HTTP status codes (404 / 409 / 500) and the success shape.
 */

// Stand-in auth: bind a user like the real jwtAuthMiddleware does.
const fakeAuth: RequestHandler = (req, _res, next) => {
  req.userId = 'user-A';
  next();
};

let httpServer: HttpServer | undefined;

afterEach(async () => {
  if (httpServer) {
    await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
    httpServer = undefined;
  }
  vi.restoreAllMocks();
});

async function mountWithRemove(
  remove: IExternalApiKeyService['remove'],
): Promise<{ baseUrl: string; remove: ReturnType<typeof vi.fn> }> {
  const spy = vi.fn(remove);
  const externalApiKeyService = { remove: spy } as unknown as IExternalApiKeyService;
  // createMcpRoutes only touches mcpService.onSessionEvicted at construction.
  const mcpService = { onSessionEvicted: () => {} } as never;
  const stub = {} as never;

  const app = express();
  app.use(express.json());
  // local-token deps (internal tokens / OAuth provider / metadata URL) are only
  // dereferenced by that route's handler — stubs suffice here.
  app.use(
    '/api',
    createMcpRoutes(mcpService, externalApiKeyService, fakeAuth, fakeAuth, stub, stub, stub, ''),
  );

  httpServer = await new Promise<HttpServer>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = (httpServer.address() as { port: number }).port;
  return { baseUrl: `http://127.0.0.1:${port}`, remove: spy };
}

async function del(baseUrl: string, id: string): Promise<Response> {
  return fetch(`${baseUrl}/api/mcp/external-api-keys/${id}/permanent`, { method: 'DELETE' });
}

describe('DELETE /mcp/external-api-keys/:id/permanent', () => {
  it('returns 200 { status: "deleted" } and forwards id + userId on success', async () => {
    const { baseUrl, remove } = await mountWithRemove(async () => {});
    const res = await del(baseUrl, 'tok-1');
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: 'deleted' });
    expect(remove).toHaveBeenCalledWith('tok-1', 'user-A');
  });

  it('maps TokenNotFoundError to 404', async () => {
    const { baseUrl } = await mountWithRemove(async () => {
      throw new TokenNotFoundError('nope');
    });
    const res = await del(baseUrl, 'missing');
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: 'nope' });
  });

  it('maps TokenStillActiveError to 409', async () => {
    const { baseUrl } = await mountWithRemove(async () => {
      throw new TokenStillActiveError('still active');
    });
    const res = await del(baseUrl, 'live');
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ error: 'still active' });
  });

  it('maps any other error to 500', async () => {
    const { baseUrl } = await mountWithRemove(async () => {
      throw new Error('boom');
    });
    const res = await del(baseUrl, 'oops');
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: 'boom' });
  });
});
