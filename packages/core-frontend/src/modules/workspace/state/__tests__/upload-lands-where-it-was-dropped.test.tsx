import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { FileTreeEntry, PullRequestSummary } from '@bevel-software/platform-shared';

const api = vi.hoisted(() => ({
  listOpenChangeRequests: vi.fn(),
  listMyChangeRequests: vi.fn(),
}));
vi.mock('../../../change-requests/services/change-requests.api', () => ({
  listOpenChangeRequests: api.listOpenChangeRequests,
  listMyChangeRequests: api.listMyChangeRequests,
  readFileOnBranch: vi.fn(),
}));

import { OpenChangeRequestsProvider } from '../open-change-requests';
import { useMergedWorkspaceTree } from '../../hooks/useMergedWorkspaceTree';
import { WorkspaceContext } from '../workspace.context';
import { makeWorkspaceFixture } from '../../__tests__/testFixtures';
import { SUGGESTIONS_OPTIMISTIC_EVENT, PR_STALE_EVENT } from '../../../../core/events';

/**
 * The third of the three reports: "the file did not appear until I reloaded".
 *
 * A suggestion-routed upload puts nothing on the branch being viewed — the
 * bytes are on the caller's personal suggestions branch — so the row the user
 * gets back is synthesized from their own open change requests. The server's
 * `touchedNodePaths` are produced by a `git diff` the background commit worker
 * can trail by many seconds, which is why the upload ANNOUNCES the paths the
 * moment they land and the provider merges the announcement until a real fetch
 * covers them.
 *
 * Both halves matter and both are pinned here: the row is there immediately
 * after the drop, and it is still there after the refetch that follows it.
 * Written against `Skills/`, the folder the report came from — the tree's
 * hidden-root rule drops a synthesized row whose top-level folder is missing
 * from the branch, and `Skills/` is exactly the kind of reserved root that
 * rule was written about.
 */

const KB = 'knowledge-base';
const DROPPED = 'Skills/house-writing-standards/report.pdf';
const ROW = `${KB}/${DROPPED}`;

/** The branch as the viewer sees it: `Skills/` exists, the dropped file does not. */
const BRANCH_TREE: FileTreeEntry = {
  name: '.',
  relativePath: '.',
  type: 'directory',
  children: [{
    name: KB,
    relativePath: KB,
    type: 'directory',
    children: [{
      name: 'Skills',
      relativePath: `${KB}/Skills`,
      type: 'directory',
      children: [{
        name: 'house-writing-standards',
        relativePath: `${KB}/Skills/house-writing-standards`,
        type: 'directory',
        children: [],
      }],
    }],
  }],
};

function cr(over: Partial<PullRequestSummary> = {}): PullRequestSummary {
  return {
    number: 12,
    title: 'Changes from Bo Business. Knowledge',
    author: { login: 'user-bo' },
    branch: 'suggestions/bo/knowledge',
    base: 'main',
    state: 'open',
    createdAt: '2026-09-17T09:00:00.000Z',
    // What the server says BEFORE its diff has caught up with the commit.
    touchedNodePaths: [],
    review: { approvals: 0, changesRequested: 0, pendingLogins: [] },
    url: '/change-requests/12',
    ...over,
  } as PullRequestSummary;
}

function wrapper({ children }: { children: ReactNode }) {
  return (
    <WorkspaceContext.Provider
      value={makeWorkspaceFixture({ kbDirName: KB, fileTree: BRANCH_TREE })}
    >
      <OpenChangeRequestsProvider>{children}</OpenChangeRequestsProvider>
    </WorkspaceContext.Provider>
  );
}

/** Every path the merged tree draws a row for. */
function pathsIn(node: FileTreeEntry | null): string[] {
  if (!node) return [];
  return [node.relativePath, ...(node.children ?? []).flatMap(pathsIn)];
}

describe('a suggestion-routed upload shows up where it was dropped', () => {
  beforeEach(() => {
    api.listOpenChangeRequests.mockReset().mockResolvedValue([]);
    api.listMyChangeRequests.mockReset().mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('draws the proposed row from the upload s own announcement, before any refetch', async () => {
    const { result } = renderHook(() => useMergedWorkspaceTree(), { wrapper });
    await waitFor(() => expect(api.listMyChangeRequests).toHaveBeenCalled());
    expect(pathsIn(result.current.tree)).not.toContain(ROW);

    // What `dispatchUpload` fires the moment the bytes are committed.
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(SUGGESTIONS_OPTIMISTIC_EVENT, {
          detail: cr({ touchedNodePaths: [DROPPED] }),
        }),
      );
    });

    expect(result.current.suggestionOnlyPaths.get(ROW)).toBe(12);
    expect(pathsIn(result.current.tree)).toContain(ROW);
  });

  it('keeps the row when the refetch that follows the upload answers', async () => {
    const { result } = renderHook(() => useMergedWorkspaceTree(), { wrapper });
    await waitFor(() => expect(api.listMyChangeRequests).toHaveBeenCalled());

    // The announcement and the stale event go out together, as the upload
    // sends them — the refetch starts before the server's diff has the path.
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(SUGGESTIONS_OPTIMISTIC_EVENT, {
          detail: cr({ touchedNodePaths: [DROPPED] }),
        }),
      );
      api.listMyChangeRequests.mockResolvedValue([cr()]);
      window.dispatchEvent(new Event(PR_STALE_EVENT));
    });
    await waitFor(() => expect(api.listMyChangeRequests).toHaveBeenCalledTimes(2));
    // The lagging answer does not take the row away again.
    expect(pathsIn(result.current.tree)).toContain(ROW);

    // And once the server's own diff carries the path, the row is the
    // server's — same row, no flicker in between.
    await act(async () => {
      api.listMyChangeRequests.mockResolvedValue([cr({ touchedNodePaths: [DROPPED] })]);
      window.dispatchEvent(new Event(PR_STALE_EVENT));
    });
    await waitFor(() => expect(api.listMyChangeRequests).toHaveBeenCalledTimes(3));
    expect(result.current.suggestionOnlyPaths.get(ROW)).toBe(12);
    expect(pathsIn(result.current.tree)).toContain(ROW);
  });
});
