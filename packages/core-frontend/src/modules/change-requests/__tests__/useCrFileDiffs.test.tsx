import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { PullRequestSummary } from '@bevel-software/platform-shared';

/**
 * The file page's change boxes: what each request does to the open file. Like
 * the request dialog, a box reads its "before" at the request's fork point —
 * an edit made on main after the proposal is not something the proposal
 * deletes.
 */

const api = vi.hoisted(() => ({ readFileOnBranch: vi.fn(), readFileAtForkPoint: vi.fn() }));
vi.mock('../services/change-requests.api', () => api);

import { useCrFileDiffs } from '../hooks/useCrFileDiffs';
import { PR_STALE_EVENT } from '../../../core/events';
import { WorkspaceApiError } from '../../workspace/services/workspace.api';

const PATH = 'Sales/deal.yaml';
const ORIGINAL = 'price: 100\nstatus: draft\n';
const MAIN_NOW = 'price: 100\nstatus: signed\n'; // edited on main after the proposal
const PROPOSED = 'price: 120\nstatus: draft\n';
const CR = { number: 21, branch: 'alice/deal', touchedNodePaths: [PATH] } as unknown as PullRequestSummary;

const lines = (d: { kind: string; text: string }[] | null | undefined | 'unreadable', kind: string) =>
  (d === 'unreadable' ? [] : (d ?? [])).filter((l) => l.kind === kind).map((l) => l.text);

beforeEach(() => {
  api.readFileOnBranch.mockReset().mockResolvedValue(PROPOSED);
  api.readFileAtForkPoint.mockReset().mockResolvedValue({ content: ORIGINAL, forkSha: 'f'.repeat(40) });
});

describe('useCrFileDiffs', () => {
  it("diffs from the request's fork point: a later edit on main is not shown as a deletion", async () => {
    const { result } = renderHook(() => useCrFileDiffs([CR], PATH, MAIN_NOW));
    await waitFor(() => expect(result.current.get(21)).not.toBeNull());
    const d = result.current.get(21)!;
    expect(lines(d, 'removed')).toEqual(['price: 100']);
    expect(lines(d, 'added')).toEqual(['price: 120']);
    expect(api.readFileAtForkPoint).toHaveBeenCalledWith(21, null, PATH);
  });

  it('re-reads the fork point when a request moves, not on every revision bump', async () => {
    const { result, rerender } = renderHook(({ rev }: { rev: number }) => useCrFileDiffs([CR], PATH, MAIN_NOW, rev), {
      initialProps: { rev: 0 },
    });
    await waitFor(() => expect(result.current.get(21)).not.toBeNull());
    expect(api.readFileAtForkPoint).toHaveBeenCalledTimes(1);

    // A tab switch or an apply elsewhere on the page re-reads the branch copy,
    // which can have changed — the fork point cannot have.
    rerender({ rev: 1 });
    await waitFor(() => expect(api.readFileOnBranch).toHaveBeenCalledTimes(2));
    expect(api.readFileAtForkPoint).toHaveBeenCalledTimes(1);

    // An Update does move it, and says so.
    await act(async () => {
      window.dispatchEvent(new Event(PR_STALE_EVENT));
    });
    await waitFor(() => expect(api.readFileAtForkPoint).toHaveBeenCalledTimes(2));
  });

  it('a file the fork point lacks (the request adds it) diffs from empty', async () => {
    api.readFileAtForkPoint.mockResolvedValue({ content: null, forkSha: 'f'.repeat(40) });
    const { result } = renderHook(() => useCrFileDiffs([CR], PATH, null));
    await waitFor(() => expect(result.current.get(21)).not.toBeNull());
    expect(lines(result.current.get(21), 'removed')).toEqual([]);
    expect(lines(result.current.get(21), 'added')).toEqual(['price: 120', 'status: draft']);
  });

  it('branches with no shared history fall back to main — the only text left', async () => {
    api.readFileAtForkPoint.mockResolvedValue({ content: null, forkSha: null });
    const { result } = renderHook(() => useCrFileDiffs([CR], PATH, MAIN_NOW));
    await waitFor(() => expect(result.current.get(21)).not.toBeNull());
    expect(lines(result.current.get(21), 'removed')).toEqual(['price: 100', 'status: signed']);
  });

  it('an unreadable fork point says so — never a diff against main, never loading forever', async () => {
    api.readFileAtForkPoint.mockRejectedValue(new Error('503'));
    const { result } = renderHook(() => useCrFileDiffs([CR], PATH, MAIN_NOW));
    await waitFor(() => expect(result.current.get(21)).toBe('unreadable'));
  });

  it('a file the request deletes (absent on its branch) shows every line removed', async () => {
    api.readFileOnBranch.mockRejectedValue(new WorkspaceApiError(404));
    const { result } = renderHook(() => useCrFileDiffs([CR], PATH, MAIN_NOW));
    await waitFor(() => expect(Array.isArray(result.current.get(21))).toBe(true));
    expect(lines(result.current.get(21), 'removed')).toEqual(['price: 100', 'status: draft']);
    expect(lines(result.current.get(21), 'added')).toEqual([]);
  });

  it('an unreadable branch copy says so too', async () => {
    api.readFileOnBranch.mockRejectedValue(new Error('403'));
    const { result } = renderHook(() => useCrFileDiffs([CR], PATH, MAIN_NOW));
    await waitFor(() => expect(result.current.get(21)).toBe('unreadable'));
  });
});
