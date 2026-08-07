import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({ readFileOnBranch: vi.fn() }));
vi.mock('../services/change-requests.api', () => ({
  readFileOnBranch: api.readFileOnBranch,
}));

import { useFileOnBranch } from '../hooks/useFileOnBranch';

beforeEach(() => {
  api.readFileOnBranch
    .mockReset()
    .mockImplementation(async (_branch: string, path: string) => `content of ${path}`);
});

describe('useFileOnBranch', () => {
  it('returns the file once the read lands', async () => {
    const { result } = renderHook(() => useFileOnBranch('main', 'Groups/Sales/deck/SKILL.md'));
    expect(result.current).toBeNull();
    await waitFor(() => expect(result.current).toBe('content of Groups/Sales/deck/SKILL.md'));
  });

  /**
   * The skill page's tabs oscillate the path: SKILL.md → a bundled file →
   * SKILL.md. The return leg finds its key already asked (correct — the answer
   * exists), so the hook must serve it FROM CACHE. The single-slot version of
   * this hook held only the LAST answer: the return leg matched nothing,
   * refetched nothing, and the pane sat on "Loading…" forever.
   */
  it('serves an earlier path from cache when the path oscillates A→B→A', async () => {
    const { result, rerender } = renderHook(({ path }) => useFileOnBranch('main', path), {
      initialProps: { path: 'skill/SKILL.md' },
    });
    await waitFor(() => expect(result.current).toBe('content of skill/SKILL.md'));

    rerender({ path: 'skill/reference/LESSONS.md' });
    await waitFor(() => expect(result.current).toBe('content of skill/reference/LESSONS.md'));

    rerender({ path: 'skill/SKILL.md' });
    // Immediately available again — no refetch, no eternal "Loading…".
    expect(result.current).toBe('content of skill/SKILL.md');
    expect(api.readFileOnBranch).toHaveBeenCalledTimes(2);
  });

  it('a null path fetches nothing and returns null', async () => {
    const { result } = renderHook(() => useFileOnBranch('main', null));
    expect(result.current).toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    expect(api.readFileOnBranch).not.toHaveBeenCalled();
  });

  it('a bumped revision refetches and serves the new copy', async () => {
    const { result, rerender } = renderHook(
      ({ rev }) => useFileOnBranch('main', 'skill/SKILL.md', rev),
      { initialProps: { rev: 0 } },
    );
    await waitFor(() => expect(result.current).toBe('content of skill/SKILL.md'));

    api.readFileOnBranch.mockImplementation(async () => 'merged copy');
    rerender({ rev: 1 });
    await waitFor(() => expect(result.current).toBe('merged copy'));
    expect(api.readFileOnBranch).toHaveBeenCalledTimes(2);
  });

  it('a failed read stays null rather than reporting an empty file', async () => {
    api.readFileOnBranch.mockRejectedValue(new Error('403'));
    const { result } = renderHook(() => useFileOnBranch('main', 'skill/SKILL.md'));
    await new Promise((r) => setTimeout(r, 0));
    expect(result.current).toBeNull();
  });
});
