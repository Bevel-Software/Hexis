import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { PendingChange, ReviewSession } from '@bevel-software/shared';
import { useReviewState } from '../useReviewState';
import { fetchReviewSession, rejectReviewChange } from '../../services/review.api';

/**
 * `useReviewState` — the optimistic reject. Rejecting a change drops the row
 * from the session immediately (before the background commit + push resolves)
 * so it feels instant; a failure reconciles the panel and surfaces the error.
 */

vi.mock('../../services/review.api', () => ({
  fetchReviewSession: vi.fn(),
  fetchReviewFile: vi.fn(),
  acceptReviewChange: vi.fn(),
  rejectReviewChange: vi.fn(),
}));

const mockFetchSession = vi.mocked(fetchReviewSession);
const mockReject = vi.mocked(rejectReviewChange);

function mkChange(path: string): PendingChange {
  return { path, kind: 'modified', isBinary: false, linesAdded: 1, linesRemoved: 1 };
}
function mkSession(paths: string[]): ReviewSession {
  return { branchName: 'main', baselineRef: '', createdAt: '', changes: paths.map(mkChange) };
}

describe('useReviewState — optimistic reject', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejectOne drops the row from the session immediately, before the API resolves', async () => {
    mockFetchSession.mockResolvedValue(mkSession(['a.md', 'b.md']));
    const { result } = renderHook(() => useReviewState('ws', 'main'));
    await waitFor(() => expect(result.current.session?.changes).toHaveLength(2));

    // Hold the reject's network promise open so we can assert mid-flight.
    let resolveApi: (v: ReviewSession | null) => void = () => {};
    mockReject.mockImplementation(() => new Promise((res) => { resolveApi = res; }));

    act(() => { void result.current.rejectOne('a.md'); });

    // Optimistic: the row is gone even though the API has not resolved.
    expect(result.current.session?.changes.map((c) => c.path)).toEqual(['b.md']);

    // `resolveApi(null)` resolves `mockReject` (the mocked
    // `rejectReviewChange` API) with `null` — the success contract
    // signal for "rejection landed, no remaining session data to merge
    // back in". The hook's optimistic update is therefore the final
    // state; we assert the optimistic removal of `a.md` survives the
    // network round-trip unchanged.
    await act(async () => { resolveApi(null); });
    expect(result.current.session?.changes.map((c) => c.path)).toEqual(['b.md']);
  });

  it('on a failed reject, reconciles to the server state and surfaces the error', async () => {
    mockFetchSession.mockResolvedValue(mkSession(['a.md', 'b.md']));
    const { result } = renderHook(() => useReviewState('ws', 'main'));
    await waitFor(() => expect(result.current.session?.changes).toHaveLength(2));

    mockReject.mockRejectedValue(new Error('push failed'));
    // The reconciling refresh refetches — the commit failed, so the file is
    // still pending server-side and comes back into the panel.
    mockFetchSession.mockResolvedValue(mkSession(['a.md', 'b.md']));

    await act(async () => { await result.current.rejectOne('a.md'); });

    expect(result.current.lastError).toBe('push failed');
    expect(result.current.session?.changes.map((c) => c.path).sort()).toEqual(['a.md', 'b.md']);
  });

  it('clearError dismisses the surfaced error', async () => {
    mockFetchSession.mockResolvedValue(mkSession(['a.md']));
    const { result } = renderHook(() => useReviewState('ws', 'main'));
    await waitFor(() => expect(result.current.session?.changes).toHaveLength(1));

    mockReject.mockRejectedValue(new Error('boom'));
    mockFetchSession.mockResolvedValue(mkSession(['a.md']));
    await act(async () => { await result.current.rejectOne('a.md'); });
    expect(result.current.lastError).toBe('boom');

    act(() => { result.current.clearError(); });
    expect(result.current.lastError).toBeNull();
  });
});
