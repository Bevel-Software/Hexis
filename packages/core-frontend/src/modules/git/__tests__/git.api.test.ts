import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createBranch,
  fetchBranches,
  fetchFileDiff,
  fetchFileHistory,
  fetchStatus,
} from '../services/git.api';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  // authFetch reads from localStorage; clear per-test.
  localStorage.clear();
});

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('git.api', () => {
  it('fetchStatus GETs the status route and returns JSON', async () => {
    fetchMock.mockResolvedValueOnce(
      ok({
        branch: 'main',
        isDirty: false,
        hasUpstream: true,
        unpushedCommits: 0,
        conflicted: [],
        unmergedFromUpstream: false,
      }),
    );
    const s = await fetchStatus('ws-1');
    expect(s.branch).toBe('main');
    expect(s.hasUpstream).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/workspace/ws-1/workflow/branch-status');
    expect(init?.method).toBeUndefined();
  });

  it('fetchBranches returns the array body', async () => {
    fetchMock.mockResolvedValueOnce(
      ok([
        { name: 'current-company-state', isCurrent: true, isProtected: true, ahead: 0, behind: 0 },
      ]),
    );
    const bs = await fetchBranches('ws-1');
    expect(bs).toHaveLength(1);
    expect(bs[0].name).toBe('current-company-state');
  });

  it('createBranch POSTs JSON body', async () => {
    fetchMock.mockResolvedValueOnce(
      ok({ name: 'feature/x', isCurrent: false, isProtected: false, ahead: null, behind: null }),
    );
    await createBranch('ws-1', 'feature/x');
    const [, init] = fetchMock.mock.calls[0];
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({ name: 'feature/x', fromBase: undefined });
  });

  // `switchBranch` removed from the API surface: under the per-branch workspace
  // model, branches are workspace identity. Switching is a URL navigation that
  // triggers the workspace bootstrap (`getOrCreateForBranch`), not a POST
  // against the source workspace's clone. The route + function have been
  // deleted together.

  it('fetchFileHistory unwraps the commits array and passes path + limit as query params', async () => {
    fetchMock.mockResolvedValueOnce(
      ok({
        changes: [
          {
            sha: 'abcdef1234567890',
            authorName: 'Ali',
            authorEmail: 'ali@example.com',
            subject: 'edit foo',
            committedAt: '2026-04-18T00:00:00Z',
          },
        ],
      }),
    );
    const history = await fetchFileHistory('ws-1', 'Knowledge/Foo.md', 5);
    expect(history).toHaveLength(1);
    expect(history[0].subject).toBe('edit foo');
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('/api/workspace/ws-1/workflow/changes?');
    expect(url).toContain('path=Knowledge%2FFoo.md');
    expect(url).toContain('limit=5');
  });

  it('fetchFileDiff returns the raw unified diff string', async () => {
    fetchMock.mockResolvedValueOnce(ok({ diff: '--- a\n+++ b\n@@ -1 +1 @@\n-foo\n+bar\n' }));
    const diff = await fetchFileDiff('ws-1', 'Knowledge/Foo.md', 'abc1234');
    expect(diff).toContain('+bar');
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('/api/workspace/ws-1/workflow/show-file?');
    expect(url).toContain('sha=abc1234');
    expect(url).toContain('path=Knowledge%2FFoo.md');
  });

  it('falls back to HTTP <status> when the server returns a non-JSON body', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>boom</html>', { status: 500 }));
    await expect(fetchStatus('ws-1')).rejects.toMatchObject({
      status: 500,
      message: 'HTTP 500',
    });
  });
});
