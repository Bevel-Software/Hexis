import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  acceptReviewChange,
  fetchReviewFile,
  fetchReviewSession,
  rejectReviewChange,
} from '../services/review.api';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  localStorage.clear();
});

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function err(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('review.api', () => {
  it('fetchReviewSession GETs the review route without a threadId query', async () => {
    fetchMock.mockResolvedValueOnce(
      ok({
        session: {
          branchName: 'alice/draft-one',
          baselineRef: 'abc123',
          createdAt: '2026-04-20T00:00:00Z',
          changes: [],
        },
      }),
    );
    const s = await fetchReviewSession('ws-1');
    expect(s?.branchName).toBe('alice/draft-one');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/workspace/ws-1/review');
    expect(init?.method).toBeUndefined();
  });

  it('fetchReviewSession returns null when the server has no active session', async () => {
    fetchMock.mockResolvedValueOnce(ok({ session: null }));
    const s = await fetchReviewSession('ws-1');
    expect(s).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fetchReviewFile encodes path into the query string', async () => {
    fetchMock.mockResolvedValueOnce(
      ok({
        path: 'Knowledge/Foo.md',
        kind: 'modified',
        baseline: 'before',
        current: 'after',
        isBinary: false,
      }),
    );
    const payload = await fetchReviewFile('ws-1', 'Knowledge/Foo.md');
    expect(payload.baseline).toBe('before');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/workspace/ws-1/review/file?path=Knowledge%2FFoo.md');
  });

  it('acceptReviewChange POSTs with path in the body for per-file accept', async () => {
    fetchMock.mockResolvedValueOnce(ok({ session: null }));
    await acceptReviewChange('ws-1', 'Knowledge/Foo.md');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/workspace/ws-1/review/accept');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({ path: 'Knowledge/Foo.md' });
  });

  it('acceptReviewChange POSTs an empty body for accept-all', async () => {
    fetchMock.mockResolvedValueOnce(ok({ session: null }));
    await acceptReviewChange('ws-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init?.body as string)).toEqual({});
  });

  it('rejectReviewChange POSTs with path in the body for per-file reject', async () => {
    fetchMock.mockResolvedValueOnce(ok({ session: null }));
    await rejectReviewChange('ws-1', 'Knowledge/Foo.md');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/workspace/ws-1/review/reject');
    expect(JSON.parse(init?.body as string)).toEqual({ path: 'Knowledge/Foo.md' });
  });

  it('surfaces non-2xx bodies as ReviewApiError with the server message', async () => {
    fetchMock.mockResolvedValueOnce(
      err(400, { error: 'path "foo.md" is not in the active review' }),
    );
    await expect(fetchReviewFile('ws-1', 'foo.md')).rejects.toMatchObject({
      name: 'ReviewApiError',
      status: 400,
      message: 'path "foo.md" is not in the active review',
    });
  });

  it('falls back to HTTP <status> when the server returns a non-JSON body', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>nope</html>', { status: 500 }));
    await expect(fetchReviewSession('ws-1')).rejects.toMatchObject({
      name: 'ReviewApiError',
      status: 500,
      message: 'HTTP 500',
    });
  });
});
