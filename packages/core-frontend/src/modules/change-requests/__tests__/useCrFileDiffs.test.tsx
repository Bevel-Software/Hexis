import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
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

const PATH = 'Sales/deal.yaml';
const ORIGINAL = 'price: 100\nstatus: draft\n';
const MAIN_NOW = 'price: 100\nstatus: signed\n'; // edited on main after the proposal
const PROPOSED = 'price: 120\nstatus: draft\n';
const CR = { number: 21, branch: 'alice/deal', touchedNodePaths: [PATH] } as unknown as PullRequestSummary;

const lines = (d: { kind: string; text: string }[] | null | undefined, kind: string) =>
  (d ?? []).filter((l) => l.kind === kind).map((l) => l.text);

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

  it('an unreadable fork point makes no claim — never a diff against main', async () => {
    api.readFileAtForkPoint.mockRejectedValue(new Error('503'));
    const { result } = renderHook(() => useCrFileDiffs([CR], PATH, MAIN_NOW));
    await waitFor(() => expect(api.readFileOnBranch).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current.get(21)).toBeNull();
  });
});
