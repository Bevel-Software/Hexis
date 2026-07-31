import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { BranchInfo } from '@bevel-software/platform-shared';
import { useGitState } from '../useGitState';
import {
  deleteBranch as apiDeleteBranch,
  fetchBranches,
  fetchStatus,
} from '../../services/git.api';

/**
 * `useGitState` — the optimistic delete. Deleting a branch hides the row
 * the instant the user confirms (before `git push --delete origin <name>`
 * resolves over the wire) so the picker feels instant; a failure
 * reconciles to server truth and rethrows so the caller surfaces the
 * error in the picker's banner.
 */

vi.mock('../../services/git.api', () => ({
  fetchStatus: vi.fn(),
  fetchBranches: vi.fn(),
  createBranch: vi.fn(),
  deleteBranch: vi.fn(),
  pull: vi.fn(),
  fetchForkBase: vi.fn(),
  revert: vi.fn(),
  fetchFileHistory: vi.fn(),
  fetchFileDiff: vi.fn(),
  fetchFileComparison: vi.fn(),
}));

const mockFetchBranches = vi.mocked(fetchBranches);
const mockFetchStatus = vi.mocked(fetchStatus);
const mockDeleteBranch = vi.mocked(apiDeleteBranch);

function mkBranch(name: string): BranchInfo {
  return { name, isProtected: false, ahead: 0, behind: 0, hasRemote: true };
}

describe('useGitState — optimistic deleteBranch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Status fetch isn't what these tests care about; resolve it so the
    // hook's initial poll doesn't reject and pollute `lastError`.
    mockFetchStatus.mockResolvedValue({
      branch: 'alice/elsewhere',
      hasUpstream: true,
      unmergedFromUpstream: false,
    });
  });

  it('hides the row immediately, before the delete API resolves', async () => {
    mockFetchBranches.mockResolvedValue([mkBranch('alice/draft'), mkBranch('bob/draft')]);
    const { result } = renderHook(() => useGitState('ws-1'));
    await waitFor(() => expect(result.current.branches).toHaveLength(2));

    // Hold the delete's network promise open so we can assert mid-flight.
    let resolveApi: () => void = () => {};
    mockDeleteBranch.mockImplementation(() => new Promise((res) => { resolveApi = res; }));

    act(() => { void result.current.deleteBranch('bob/draft'); });

    // Optimistic: bob/draft is gone from the exposed list even though
    // `apiDeleteBranch` has not yet resolved.
    expect(result.current.branches.map((b) => b.name)).toEqual(['alice/draft']);

    // Resolve the delete API. fetchBranches is called by the post-success
    // refresh — return the server's new truth (bob/draft gone).
    mockFetchBranches.mockResolvedValue([mkBranch('alice/draft')]);
    await act(async () => { resolveApi(); });

    // Final state matches the optimistic decision — no flicker.
    await waitFor(() =>
      expect(result.current.branches.map((b) => b.name)).toEqual(['alice/draft']),
    );
  });

  it('on failure, restores the row and rethrows the error', async () => {
    mockFetchBranches.mockResolvedValue([mkBranch('alice/draft'), mkBranch('bob/draft')]);
    const { result } = renderHook(() => useGitState('ws-1'));
    await waitFor(() => expect(result.current.branches).toHaveLength(2));

    mockDeleteBranch.mockRejectedValue(new Error('push failed'));
    // The reconciling refresh after failure refetches — the delete didn't
    // commit, so bob/draft is still there server-side.
    mockFetchBranches.mockResolvedValue([mkBranch('alice/draft'), mkBranch('bob/draft')]);

    await expect(
      act(async () => { await result.current.deleteBranch('bob/draft'); }),
    ).rejects.toThrow('push failed');

    // Row is back — pendingDeletes was cleared in the `finally` and
    // rawBranches still contains bob/draft per the failed-state refresh.
    expect(result.current.branches.map((b) => b.name).sort()).toEqual([
      'alice/draft',
      'bob/draft',
    ]);
  });
});
