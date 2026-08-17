import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the shared auth fetch so we can drive arbitrary responses without a
// real network call. The module under test binds to this import at load.
vi.mock('../../../lib/api', () => ({ authFetch: vi.fn() }));

import { getMcpServer } from '../services/tools.api';
import { authFetch } from '../../../lib/api';

const mockedFetch = vi.mocked(authFetch);

/**
 * The GET `/server` 404 split: the backend answers 404 for BOTH the expected
 * absence (`Not found` — a `.tool`-backed manual has no server pair) and a
 * deployment fault (`Not available` — the edit service isn't wired). Only the
 * first may become `null`; folding both would render a misconfigured backend
 * as a quietly server-less page.
 */

function jsonRes(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('getMcpServer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('maps the expected Not found 404 (a .tool-backed manual) to null', async () => {
    mockedFetch.mockResolvedValueOnce(jsonRes(404, { error: 'Not found' }));
    await expect(getMcpServer('files')).resolves.toBeNull();
  });

  it('surfaces a Not available 404 (edit service not wired) as an error', async () => {
    mockedFetch.mockResolvedValueOnce(jsonRes(404, { error: 'Not available' }));
    await expect(getMcpServer('vendor')).rejects.toThrow('Not available');
  });

  it('surfaces a bodyless 404 as an error, not a silent absence', async () => {
    mockedFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => {
        throw new Error('not json');
      },
    } as unknown as Response);
    await expect(getMcpServer('vendor')).rejects.toThrow(
      "Couldn't load the server configuration.",
    );
  });

  it('returns the view on 200', async () => {
    const view = {
      name: 'vendor',
      transport: 'streamable-http',
      url: 'https://v.example/mcp',
      literalHeaders: {},
      authHeaders: {},
      variables: [],
      local: false,
      canWrite: true,
    };
    mockedFetch.mockResolvedValueOnce(jsonRes(200, view));
    await expect(getMcpServer('vendor')).resolves.toEqual(view);
  });
});
