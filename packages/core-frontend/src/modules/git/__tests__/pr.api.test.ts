import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  listPullRequestsForMe,
  listMyPullRequests,
  getPullRequest,
} from '../services/pr.api';

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

describe('pr.api', () => {
  it('listPullRequestsForMe GETs the workflow for-me route', async () => {
    fetchMock.mockResolvedValueOnce(ok([]));
    const result = await listPullRequestsForMe();
    expect(result).toEqual([]);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/workflow/change-requests/for-me');
  });

  it('listMyPullRequests GETs the workflow mine route and returns the parsed body', async () => {
    fetchMock.mockResolvedValueOnce(ok([]));
    const result = await listMyPullRequests();
    expect(result).toEqual([]);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/workflow/change-requests/mine');
  });

  it('getPullRequest GETs the workflow change-request detail route', async () => {
    fetchMock.mockResolvedValueOnce(ok({ number: 42, title: 't' }));
    const pr = await getPullRequest(42);
    expect(pr.number).toBe(42);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/workflow/change-requests/42');
  });
});
