import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { PullRequestSummary } from '@bevel-software/platform-shared';

const api = vi.hoisted(() => ({
  listOpenChangeRequests: vi.fn(),
  listPullRequestsForMe: vi.fn(),
}));
vi.mock('../../../library/services/library.api', () => ({
  listOpenChangeRequests: api.listOpenChangeRequests,
}));
vi.mock('../../../git/services/pr.api', () => ({
  listPullRequestsForMe: api.listPullRequestsForMe,
}));

import { OpenChangeRequestsProvider } from '../../state/open-change-requests';
import { useOpenChangeRequests } from '../useOpenChangeRequests';
import {
  WorkspaceContext,
  type WorkspaceContextValue,
} from '../../state/workspace.context';

function pr(over: Partial<PullRequestSummary> = {}): PullRequestSummary {
  return {
    number: 32,
    title: 'Tighten the enforcement wording',
    author: { login: 'bevel-bot' },
    appAuthor: { name: 'Ali Raza' },
    branch: 'ali/wording',
    base: 'main',
    state: 'open',
    createdAt: '2026-07-27T00:00:00.000Z',
    touchedNodePaths: ['Knowledge/Foo.md'],
    review: { approvals: 0, changesRequested: 0, pendingLogins: [] },
    url: 'https://example.com/pr/32',
    ...over,
  };
}

function wrapper(kbDirName: string | null) {
  return ({ children }: { children: ReactNode }) => (
    <WorkspaceContext.Provider value={{ kbDirName } as unknown as WorkspaceContextValue}>
      <OpenChangeRequestsProvider>{children}</OpenChangeRequestsProvider>
    </WorkspaceContext.Provider>
  );
}

const renderIt = (kbDirName: string | null = 'knowledge-base') =>
  renderHook(() => useOpenChangeRequests(), { wrapper: wrapper(kbDirName) });

describe('useOpenChangeRequests', () => {
  beforeEach(() => {
    api.listOpenChangeRequests.mockReset();
    api.listPullRequestsForMe.mockReset();
    api.listOpenChangeRequests.mockResolvedValue([pr()]);
  });

  /**
   * THE decisive case. `touchedNodePaths` is KB-repo-relative; the tree, the
   * tabs and `openFilePath` are workspace-relative and carry the kbDirName
   * prefix. A Set built straight from `touchedNodePaths` matches ZERO rows —
   * and a degraded signal renders nothing, so the bug ships looking exactly
   * like "there are no open requests".
   *
   * Both literals are written out on purpose: a fixture that shares one path
   * space tests nothing.
   */
  it('joins the two path spaces on ingest', async () => {
    const { result } = renderIt('knowledge-base');
    await waitFor(() =>
      expect(result.current.paths.has('knowledge-base/Knowledge/Foo.md')).toBe(true),
    );
    // And emphatically NOT the raw repo-relative form.
    expect(result.current.paths.has('Knowledge/Foo.md')).toBe(false);
  });

  it('returns an empty set while kbDirName is unknown, not one that matches nothing', async () => {
    const { result } = renderIt(null);
    await waitFor(() => expect(api.listOpenChangeRequests).toHaveBeenCalled());
    expect(result.current.paths.size).toBe(0);
    expect(result.current.forPath('Knowledge/Foo.md')).toEqual([]);
  });

  it('returns every request touching a workspace-relative path', async () => {
    api.listOpenChangeRequests.mockResolvedValue([
      pr({ number: 32, touchedNodePaths: ['Knowledge/Foo.md', 'Knowledge/Bar.md'] }),
      pr({ number: 41, touchedNodePaths: ['Knowledge/Foo.md'] }),
      pr({ number: 55, touchedNodePaths: ['Data/velocity.csv'] }),
    ]);
    const { result } = renderIt();
    await waitFor(() =>
      expect(result.current.forPath('knowledge-base/Knowledge/Foo.md')).toHaveLength(2),
    );
    expect(
      result.current.forPath('knowledge-base/Knowledge/Foo.md').map((p) => p.number),
    ).toEqual([32, 41]);
    expect(result.current.forPath('knowledge-base/Data/velocity.csv')).toHaveLength(1);
    expect(result.current.forPath('knowledge-base/Knowledge/Nothing.md')).toEqual([]);
  });

  it('yields an empty set with no open requests, and does not throw', async () => {
    api.listOpenChangeRequests.mockResolvedValue([]);
    const { result } = renderIt();
    await waitFor(() => expect(api.listOpenChangeRequests).toHaveBeenCalled());
    expect(result.current.paths.size).toBe(0);
  });

  it('renders nothing rather than an error state when the list cannot load', async () => {
    api.listOpenChangeRequests.mockRejectedValue(new Error('network down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { result } = renderIt();
    await waitFor(() => expect(warn).toHaveBeenCalled());
    expect(result.current.paths.size).toBe(0);
    warn.mockRestore();
  });

  /**
   * The difference between a dot and no dot for a colleague's request. The
   * dock's endpoint is filtered by the backend to requests you authored or
   * whose paths you can WRITE; the dot is a signal, not a queue, and must not
   * inherit that scoping — otherwise the same file shows a change-request
   * marker in the Library and none in Knowledge.
   */
  it('reads the broad endpoint, never the dock’s you-scoped one', async () => {
    const { result } = renderIt();
    await waitFor(() => expect(result.current.paths.size).toBe(1));
    expect(api.listOpenChangeRequests).toHaveBeenCalled();
    expect(api.listPullRequestsForMe).not.toHaveBeenCalled();
  });

  it('issues ONE request however many consumers read it', async () => {
    const { result } = renderHook(
      () => [useOpenChangeRequests(), useOpenChangeRequests(), useOpenChangeRequests()],
      { wrapper: wrapper('knowledge-base') },
    );
    await waitFor(() => expect(result.current[0].paths.size).toBe(1));
    expect(api.listOpenChangeRequests).toHaveBeenCalledTimes(1);
  });
});
