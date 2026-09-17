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
import { DEFAULT_BRANCH } from '@bevel-software/platform-shared';
import { WorkspaceApiError } from '../../workspace/services/workspace.api';

const PATH = 'Sales/deal.yaml';
const ORIGINAL = 'price: 100\nstatus: draft\n';
const MAIN_NOW = 'price: 100\nstatus: signed\n'; // edited on main after the proposal
const PROPOSED = 'price: 120\nstatus: draft\n';
const CR = { number: 21, branch: 'alice/deal', touchedNodePaths: [PATH] } as unknown as PullRequestSummary;

const lines = (d: { kind: string; text: string }[] | null | undefined | 'unreadable', kind: string) =>
  (d === 'unreadable' ? [] : (d ?? [])).filter((l) => l.kind === kind).map((l) => l.text);

beforeEach(() => {
  // The proposal branch answers with its copy; main, when it is read at all,
  // answers with the tip carrying the later direct edit.
  api.readFileOnBranch
    .mockReset()
    .mockImplementation(async (branch: string) => (branch === DEFAULT_BRANCH ? MAIN_NOW : PROPOSED));
  api.readFileAtForkPoint.mockReset().mockResolvedValue({ content: ORIGINAL, forkSha: 'f'.repeat(40) });
});

describe('useCrFileDiffs', () => {
  it("diffs from the request's fork point: a later edit on main is not shown as a deletion", async () => {
    const { result } = renderHook(() => useCrFileDiffs([CR], PATH));
    await waitFor(() => expect(result.current.get(21)).not.toBeNull());
    const d = result.current.get(21)!;
    expect(lines(d, 'removed')).toEqual(['price: 100']);
    expect(lines(d, 'added')).toEqual(['price: 120']);
    expect(api.readFileAtForkPoint).toHaveBeenCalledWith(21, null, PATH);
  });

  it('after an Update both sides move together — the target\'s own newer line is never a deletion', async () => {
    // Exactly what a successful Update leaves behind: the proposal branch now
    // carries the target's line too, and the fork point is the target it was
    // merged from. Re-reading only the fork point put THAT text opposite the
    // branch copy cached from before the merge, and the box struck through the
    // target's own edit — the failure this test exists for.
    const MERGED_BRANCH = 'price: 120\nstatus: signed\n';
    const { result } = renderHook(() => useCrFileDiffs([CR], PATH));
    await waitFor(() => expect(result.current.get(21)).not.toBeNull());
    expect(lines(result.current.get(21), 'removed')).toEqual(['price: 100']);

    api.readFileAtForkPoint.mockResolvedValue({ content: MAIN_NOW, forkSha: 'e'.repeat(40) });
    // Hold the BRANCH copy so the fork point lands first — the order that used
    // to mix, because the branch side was served from the pre-merge cache and
    // the target's own newer line read as a deletion.
    let releaseBranch: (content: string) => void = () => {};
    api.readFileOnBranch.mockImplementationOnce(
      () => new Promise((resolve) => (releaseBranch = resolve)),
    );
    await act(async () => {
      window.dispatchEvent(new Event(PR_STALE_EVENT));
    });

    // Both sides are read again — the branch copy as well as the fork point.
    await waitFor(() => expect(api.readFileOnBranch).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(api.readFileAtForkPoint).toHaveBeenCalledTimes(2));
    // The fork point has landed and the branch copy has not: the box waits,
    // rather than showing a diff between two moments.
    expect(result.current.get(21)).toBeNull();

    await act(async () => {
      releaseBranch(MERGED_BRANCH);
    });
    await waitFor(() =>
      expect(lines(result.current.get(21), 'added')).toEqual(['price: 120']),
    );
    expect(lines(result.current.get(21), 'removed')).toEqual(['price: 100']);
  });

  it('re-reads the fork point when a request moves, not on every revision bump', async () => {
    const { result, rerender } = renderHook(({ rev }: { rev: number }) => useCrFileDiffs([CR], PATH, rev), {
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
    const { result } = renderHook(() => useCrFileDiffs([CR], PATH));
    await waitFor(() => expect(result.current.get(21)).not.toBeNull());
    expect(lines(result.current.get(21), 'removed')).toEqual([]);
    expect(lines(result.current.get(21), 'added')).toEqual(['price: 120', 'status: draft']);
  });

  it('branches with no shared history fall back to main — the only text left', async () => {
    api.readFileAtForkPoint.mockResolvedValue({ content: null, forkSha: null });
    const { result } = renderHook(() => useCrFileDiffs([CR], PATH));
    await waitFor(() => expect(result.current.get(21)).not.toBeNull());
    expect(lines(result.current.get(21), 'removed')).toEqual(['price: 100', 'status: signed']);
    // Main is read HERE, under this generation — and only because there was no
    // fork point to read instead.
    expect(api.readFileOnBranch).toHaveBeenCalledWith(DEFAULT_BRANCH, PATH);
  });

  it('never reads main for a request that has a fork point', async () => {
    const { result } = renderHook(() => useCrFileDiffs([CR], PATH));
    await waitFor(() => expect(result.current.get(21)).not.toBeNull());
    expect(api.readFileOnBranch).not.toHaveBeenCalledWith(DEFAULT_BRANCH, PATH);
  });

  it('a stale event re-reads main too, so an unrelated-history box never pairs two moments', async () => {
    api.readFileAtForkPoint.mockResolvedValue({ content: null, forkSha: null });
    const { result } = renderHook(() => useCrFileDiffs([CR], PATH));
    await waitFor(() => expect(result.current.get(21)).not.toBeNull());

    // Main moved on, and so did the proposal.
    api.readFileOnBranch.mockImplementation(async (branch: string) =>
      branch === DEFAULT_BRANCH ? 'price: 100\nstatus: closed\n' : 'price: 140\nstatus: closed\n',
    );
    await act(async () => {
      window.dispatchEvent(new Event(PR_STALE_EVENT));
    });
    await waitFor(() =>
      expect(lines(result.current.get(21), 'added')).toEqual(['price: 140']),
    );
    // Against main as it stands NOW: its own 'status: closed' is not a deletion.
    expect(lines(result.current.get(21), 'removed')).toEqual(['price: 100']);
  });

  it('an unreadable fork point says so — never a diff against main, never loading forever', async () => {
    api.readFileAtForkPoint.mockRejectedValue(new Error('503'));
    const { result } = renderHook(() => useCrFileDiffs([CR], PATH));
    await waitFor(() => expect(result.current.get(21)).toBe('unreadable'));
  });

  it('a file the request deletes (absent on its branch) shows every line removed', async () => {
    api.readFileOnBranch.mockRejectedValue(new WorkspaceApiError(404));
    const { result } = renderHook(() => useCrFileDiffs([CR], PATH));
    await waitFor(() => expect(Array.isArray(result.current.get(21))).toBe(true));
    expect(lines(result.current.get(21), 'removed')).toEqual(['price: 100', 'status: draft']);
    expect(lines(result.current.get(21), 'added')).toEqual([]);
  });

  it('an unreadable branch copy says so too', async () => {
    api.readFileOnBranch.mockRejectedValue(new Error('403'));
    const { result } = renderHook(() => useCrFileDiffs([CR], PATH));
    await waitFor(() => expect(result.current.get(21)).toBe('unreadable'));
  });
});
