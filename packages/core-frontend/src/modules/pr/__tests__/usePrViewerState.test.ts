import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { usePrViewerState } from '../hooks/usePrViewerState';
import { fetchPrDetail } from '../services/pr-detail.api';
import { GitApiError } from '../../git/services/git.api';

vi.mock('../services/pr-detail.api', () => ({
  fetchPrDetail: vi.fn(),
}));

// The event bus is optional in the hook (null → no subscriptions), which is the
// default when no EventBusContext is mounted. renderHook mounts the hook with no
// provider, so `useEventBus()` returns null and the bus effect is a no-op.

const mockFetch = vi.mocked(fetchPrDetail);

describe('usePrViewerState — a deleted/absent CR surfaces as notFound, not an error', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('sets notFound (not a generic error) when the CR load 404s', async () => {
    // This is the routine-deep-link case: the run pinned a CR number whose row
    // is gone, so the detail fetch 404s. The viewer must show the calm
    // "no longer available" state, driven by `notFound`, rather than the
    // alarming error banner driven by `lastError` alone.
    mockFetch.mockRejectedValue(new GitApiError(404, 'change request not found'));

    const { result } = renderHook(() => usePrViewerState());
    act(() => {
      result.current.openPr(2);
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.notFound).toBe(true);
    expect(result.current.detail).toBeNull();
    // lastError is still populated (for diagnostics), but the component branches
    // on notFound FIRST, so the user never sees the red error for a gone CR.
    expect(result.current.lastError).toBe('change request not found');
  });

  it('does NOT set notFound for a transient (non-404) failure', async () => {
    // A 500 / network blip is a real, retryable failure — it must keep the
    // error affordance, not masquerade as "the CR is gone".
    mockFetch.mockRejectedValue(new GitApiError(500, 'internal error'));

    const { result } = renderHook(() => usePrViewerState());
    act(() => {
      result.current.openPr(7);
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.notFound).toBe(false);
    expect(result.current.lastError).toBe('internal error');
  });

  it('clears notFound when the viewer is closed', async () => {
    mockFetch.mockRejectedValue(new GitApiError(404, 'change request not found'));
    const { result } = renderHook(() => usePrViewerState());

    act(() => {
      result.current.openPr(2);
    });
    await waitFor(() => expect(result.current.notFound).toBe(true));

    act(() => {
      result.current.closeViewer();
    });
    await waitFor(() => expect(result.current.notFound).toBe(false));
    expect(result.current.openPrNumber).toBeNull();
  });
});
