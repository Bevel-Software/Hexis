import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * `fileExistsOnWorkspace` decides between a finished request's "Open page" and
 * "This page has since been deleted." Only a 404 is "deleted" and only a 2xx
 * is "there"; everything else is a failed read the view offers to try again,
 * so a broken server is never taken for either answer.
 */

import { fileExistsOnWorkspace } from '../services/change-requests.api';
import { WorkspaceApiError } from '../../workspace';

afterEach(() => vi.unstubAllGlobals());

function answers(res: Response | Error) {
  const fetchMock = vi.fn(() => (res instanceof Error ? Promise.reject(res) : Promise.resolve(res)));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('fileExistsOnWorkspace', () => {
  it('asks with a HEAD on the raw route, and a 200 is "there"', async () => {
    const fetchMock = answers(new Response(null, { status: 200 }));
    await expect(fileExistsOnWorkspace('ws-7', 'knowledge-base/Docs/Price list.yaml')).resolves.toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe('HEAD');
    // The raw route of that workspace and that file, path encoded, and nothing
    // else: no ref (today's page) and no download.
    expect(url).toBe('/api/workspace/ws-7/file/raw?path=knowledge-base%2FDocs%2FPrice%20list.yaml');
  });

  it('a 404 is "deleted"', async () => {
    answers(new Response(null, { status: 404 }));
    await expect(fileExistsOnWorkspace('ws-7', 'knowledge-base/Docs/pricing.yaml')).resolves.toBe(false);
  });

  it.each([403, 500, 502])('a %i rejects with its status', async (status) => {
    answers(new Response(null, { status }));
    const err = await fileExistsOnWorkspace('ws-7', 'knowledge-base/Docs/pricing.yaml').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkspaceApiError);
    expect((err as WorkspaceApiError).status).toBe(status);
  });

  it('a network drop rejects with what fetch threw', async () => {
    const drop = new TypeError('Failed to fetch');
    answers(drop);
    await expect(fileExistsOnWorkspace('ws-7', 'knowledge-base/Docs/pricing.yaml')).rejects.toBe(drop);
  });
});
