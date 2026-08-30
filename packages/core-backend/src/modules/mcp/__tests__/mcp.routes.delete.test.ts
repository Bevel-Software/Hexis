import { afterEach, describe, expect, it, vi } from 'vitest';
import { TokenNotFoundError, TokenStillActiveError } from '../../tool-auth/external-api-key.errors.js';
import type { IExternalApiKeyService } from '../../tool-auth/external-api-key.interface.js';
import { closeMountedRoutes, mountMcpRoutes } from './mcp-routes-harness.js';

/**
 * Focused coverage for the status mapping of
 *   DELETE /api/mcp/external-api-keys/:id/permanent
 * The MCP e2e test exercises transport/proxy behaviour but never this route, so
 * this locks down how the handler translates the service's error types into
 * HTTP status codes (404 / 409 / 500) and the success shape.
 */

afterEach(async () => {
  await closeMountedRoutes();
  vi.restoreAllMocks();
});

async function mountWithRemove(
  remove: IExternalApiKeyService['remove'],
): Promise<{ baseUrl: string; remove: ReturnType<typeof vi.fn> }> {
  const spy = vi.fn(remove);
  const externalApiKeyService = { remove: spy } as unknown as IExternalApiKeyService;
  // The local-token deps (internal tokens / OAuth provider / metadata URL) are
  // only dereferenced by that route's handler, so the harness's stubs suffice.
  const baseUrl = await mountMcpRoutes({ externalApiKeyService });
  return { baseUrl, remove: spy };
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
