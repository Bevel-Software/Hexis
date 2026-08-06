import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { PullRequestSummary } from '@bevel-software/platform-shared';

const api = vi.hoisted(() => ({
  listOpenChangeRequests: vi.fn(),
  listMyChangeRequests: vi.fn(),
  listPullRequestsForMe: vi.fn(),
}));
vi.mock('../../../change-requests/services/change-requests.api', () => ({
  listOpenChangeRequests: api.listOpenChangeRequests,
  listMyChangeRequests: api.listMyChangeRequests,
  readFileOnBranch: vi.fn(),
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
    api.listMyChangeRequests.mockReset();
    api.listPullRequestsForMe.mockReset();
    api.listOpenChangeRequests.mockResolvedValue([pr()]);
    api.listMyChangeRequests.mockResolvedValue([]);
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

  /**
   * The suggestion overlay's data. `/mine` is the one endpoint that can
   * answer "is this request YOURS" (the identity filter is an email-hash
   * match, server-side), and the map joins the same two path spaces as the
   * broad set — a raw repo-relative key would match zero tree rows.
   */
  it('maps my own open requests to workspace-relative paths with their number', async () => {
    api.listMyChangeRequests.mockResolvedValue([
      pr({ number: 12, touchedNodePaths: ['Knowledge/New idea.md'] }),
      pr({ number: 13, state: 'merged', touchedNodePaths: ['Knowledge/Done.md'] }),
    ]);
    const { result } = renderIt();
    await waitFor(() =>
      expect(result.current.minePaths.get('knowledge-base/Knowledge/New idea.md')).toBe(12),
    );
    // A merged request is history, not a suggestion — it must not resurrect a row.
    expect(result.current.minePaths.has('knowledge-base/Knowledge/Done.md')).toBe(false);
    expect(result.current.minePaths.has('Knowledge/New idea.md')).toBe(false);
  });

  it('degrades to no suggestion rows when /mine cannot load', async () => {
    api.listMyChangeRequests.mockRejectedValue(new Error('network down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { result } = renderIt();
    await waitFor(() => expect(result.current.paths.size).toBe(1));
    expect(result.current.minePaths.size).toBe(0);
    warn.mockRestore();
  });

  /**
   * The stale event fires because its sender KNOWS the list changed (a
   * proposal sent, a suggestion-routed upload landed). The refetch must
   * bypass the backend's 30s list cache, or the suggestion rows for the
   * just-uploaded file sit invisible until the TTL — the initial load, with
   * no such knowledge, takes the cache.
   */
  it('refetches FRESH on the stale event, cached on initial load', async () => {
    const { result } = renderIt();
    await waitFor(() => expect(result.current.paths.size).toBe(1));
    expect(api.listMyChangeRequests).toHaveBeenCalledWith({});
    expect(api.listOpenChangeRequests).toHaveBeenCalledWith({});

    window.dispatchEvent(new Event('bevel:pr-stale'));
    await waitFor(() =>
      expect(api.listMyChangeRequests).toHaveBeenCalledWith({ fresh: true }),
    );
    expect(api.listOpenChangeRequests).toHaveBeenCalledWith({ fresh: true });
  });

  /**
   * The optimistic path: a suggestion-routed upload announces the request it
   * just made true, and the rows must derive from it IMMEDIATELY — the
   * server's own touched-path diff can trail the background commit worker by
   * many seconds. A later real fetch that covers the paths takes over and the
   * announcement is dropped.
   */
  it('derives rows from an announced request until a real fetch covers it', async () => {
    api.listMyChangeRequests.mockResolvedValue([]);
    const { result } = renderIt();
    await waitFor(() => expect(api.listMyChangeRequests).toHaveBeenCalled());

    const announced = pr({
      number: 12,
      branch: 'suggestions/razvan/knowledge',
      touchedNodePaths: ['KnowledgeBase/Ops/dropped.md'],
    });
    act(() => {
      window.dispatchEvent(
        new CustomEvent('bevel:suggestions-optimistic', { detail: announced }),
      );
    });
    // Rows NOW — path-space joined, number known, clickable via forPath.
    expect(result.current.minePaths.get('knowledge-base/KnowledgeBase/Ops/dropped.md')).toBe(12);
    expect(result.current.mineNumbers.has(12)).toBe(true);
    expect(
      result.current.forPath('knowledge-base/KnowledgeBase/Ops/dropped.md').map((c) => c.number),
    ).toEqual([12]);

    // The server catches up: a FRESH fetch carries the path → the real entry
    // takes over, and the derived values stay identical.
    api.listMyChangeRequests.mockResolvedValue([announced]);
    act(() => {
      window.dispatchEvent(new Event('bevel:pr-stale'));
    });
    await waitFor(() =>
      expect(api.listMyChangeRequests).toHaveBeenCalledWith({ fresh: true }),
    );
    await waitFor(() =>
      expect(result.current.minePaths.get('knowledge-base/KnowledgeBase/Ops/dropped.md')).toBe(12),
    );
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
