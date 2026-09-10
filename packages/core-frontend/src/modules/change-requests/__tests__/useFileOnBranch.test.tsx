import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({ readFileOnBranch: vi.fn() }));
vi.mock('../services/change-requests.api', () => ({
  readFileOnBranch: api.readFileOnBranch,
}));

import { useFileOnBranch, useFileOnBranchRead } from '../hooks/useFileOnBranch';

beforeEach(() => {
  api.readFileOnBranch
    .mockReset()
    .mockImplementation(async (_branch: string, path: string) => `content of ${path}`);
});

describe('useFileOnBranch', () => {
  it('returns the file once the read lands', async () => {
    const { result } = renderHook(() => useFileOnBranch('main', 'Plugins/Sales/deck/SKILL.md'));
    expect(result.current).toBeNull();
    await waitFor(() => expect(result.current).toBe('content of Plugins/Sales/deck/SKILL.md'));
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

/**
 * A caller that cannot tell "failed" from "in flight" can only render
 * "Loading…" for both — which is what left the change-request pane hanging on
 * a file the default branch does not have.
 */
describe('useFileOnBranchRead', () => {
  it('reports a settled failure as a failure, not as a wait', async () => {
    api.readFileOnBranch.mockRejectedValue(new Error('404'));
    const { result } = renderHook(() => useFileOnBranchRead('main', 'Ops/gone.yaml'));
    expect(result.current).toEqual({ content: null, failed: false });
    await waitFor(() => expect(result.current).toEqual({ content: null, failed: true }));
    // Settled means settled: the failure is cached, not retried on every render.
    expect(api.readFileOnBranch).toHaveBeenCalledTimes(1);
  });

  it('a landed read is not a failure, and an unasked one is neither', async () => {
    const { result, rerender } = renderHook(({ path }) => useFileOnBranchRead('main', path), {
      initialProps: { path: null as string | null },
    });
    expect(result.current).toEqual({ content: null, failed: false });

    rerender({ path: 'skill/SKILL.md' });
    await waitFor(() =>
      expect(result.current).toEqual({ content: 'content of skill/SKILL.md', failed: false }),
    );
  });

  it('keys the failure to its own path — a sibling read is unaffected', async () => {
    api.readFileOnBranch.mockImplementation(async (_branch: string, path: string) => {
      if (path === 'Ops/gone.yaml') throw new Error('404');
      return `content of ${path}`;
    });
    const { result, rerender } = renderHook(({ path }) => useFileOnBranchRead('main', path), {
      initialProps: { path: 'Ops/gone.yaml' },
    });
    await waitFor(() => expect(result.current.failed).toBe(true));

    rerender({ path: 'Ops/here.yaml' });
    await waitFor(() => expect(result.current.content).toBe('content of Ops/here.yaml'));
    expect(result.current.failed).toBe(false);

    rerender({ path: 'Ops/gone.yaml' });
    expect(result.current).toEqual({ content: null, failed: true });
  });
});
