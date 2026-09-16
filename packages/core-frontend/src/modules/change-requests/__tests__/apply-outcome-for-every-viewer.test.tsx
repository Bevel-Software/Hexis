import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import type {
  ChangeRequestApplyFailure,
  PullRequestSummary,
  WorkflowEvent,
  WorkflowEventPayload,
} from '@bevel-software/platform-shared';

const detailMock = vi.hoisted(() => ({ fetchPrDetail: vi.fn() }));
vi.mock('../../pr/services/pr-detail.api', () => ({ fetchPrDetail: detailMock.fetchPrDetail }));
const mergeMock = vi.hoisted(() => ({ mergePullRequest: vi.fn() }));
vi.mock('../../pr/services/pr-merge.api', () => ({ mergePullRequest: mergeMock.mergePullRequest }));
vi.mock('../../pr/services/pr-approvals.api', () => ({
  approvePrFile: vi.fn(),
  revertPrFile: vi.fn(),
  unapprovePrFile: vi.fn(),
}));
vi.mock('../../pr/services/pr-cancel.api', () => ({
  cancelPullRequest: vi.fn(),
  deleteChangeRequest: vi.fn(),
}));
vi.mock('../services/change-requests.api', () => ({
  readFileOnBranch: vi.fn(async () => 'branch copy'),
}));

import { refusalLine, useApplyChangeRequest } from '../hooks/useApplyChangeRequest';
import { ChangeRequestDialog } from '../components/ChangeRequestDialog';
import {
  EventBusContext,
  type EventBusContextValue,
} from '../../workflow/state/event-bus.context';

/**
 * The other half of the ticket: a FAILED apply used to be told only to the
 * person who clicked (a user-scoped event, read by the clicking tab's hook).
 * The request's author and any other owner saw it still pending with no word
 * of why. The refusal is now persisted on the request and read back by every
 * viewer; these tests pin what a SECOND viewer sees, and the clicker's own
 * backstop for an outcome event that never arrives.
 */

const CR: PullRequestSummary = {
  number: 7,
  title: 'Upload into Plugins/x',
  authorId: 'bo',
  author: { login: 'user-bo', name: 'Bo Business' },
  appAuthor: { name: 'Bo Business' },
  branch: 'suggestions/bo/knowledge',
  base: 'main',
  state: 'open',
  createdAt: '2026-09-16T09:00:00.000Z',
  touchedNodePaths: ['Plugins/x/SKILL.md'],
  review: { approvals: 0, changesRequested: 0, pendingLogins: [] },
  url: '/change-requests/7',
};

const FAILURE: ChangeRequestApplyFailure = {
  reason: 'Waiting on approval for Plugins/x/SKILL.md from Plugin owners.',
  conflicts: false,
  at: '2026-09-16T10:00:00.000Z',
  byName: 'Ada Admin',
};

function fakeBus() {
  const handlers = new Map<string, Set<(e: WorkflowEvent) => void>>();
  const value: EventBusContextValue = {
    subscribe: (kind, handler) => {
      const set = handlers.get(kind) ?? new Set();
      set.add(handler as (e: WorkflowEvent) => void);
      handlers.set(kind, set);
      return () => set.delete(handler as (e: WorkflowEvent) => void);
    },
    setFocus: () => {},
    watchWorkspace: () => () => {},
  };
  const emit = (event: WorkflowEventPayload) => {
    for (const h of handlers.get(event.kind) ?? []) {
      h({ id: 1, ts: new Date().toISOString(), ...event } as WorkflowEvent);
    }
  };
  return { value, emit };
}

function detail(over: { state?: string; lastApplyFailure?: ChangeRequestApplyFailure | null } = {}) {
  return {
    ...CR,
    state: over.state ?? 'open',
    lastApplyFailure: over.lastApplyFailure ?? null,
    body: '',
    headSha: 'h',
    baseSha: 'b',
    files: [
      {
        path: 'Plugins/x/SKILL.md',
        status: 'added' as const,
        additions: 3,
        deletions: 0,
        isBinary: false,
        sha: '',
        rawUrl: '',
      },
    ],
    comments: [],
    approvals: [],
    mergeableInBevel: true,
    mergeBlockedReasons: [],
    mergeWarnings: [],
    viewerCanBypassMerge: false,
    viewerCanCancel: false,
  };
}

beforeEach(() => {
  detailMock.fetchPrDetail.mockReset();
  mergeMock.mergePullRequest.mockReset();
});

describe('a failed apply is visible to a second viewer', () => {
  it('the dialog of a viewer who did not click shows who failed to apply it and why, live', async () => {
    const bus = fakeBus();
    detailMock.fetchPrDetail.mockResolvedValue(detail());
    render(
      <EventBusContext.Provider value={bus.value}>
        <ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />
      </EventBusContext.Provider>,
    );
    await waitFor(() => expect(detailMock.fetchPrDetail).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/could not apply this/)).not.toBeInTheDocument();

    // The admin's apply fails elsewhere; the server persisted the refusal.
    detailMock.fetchPrDetail.mockResolvedValue(detail({ lastApplyFailure: FAILURE }));
    act(() => bus.emit({ kind: 'change-request-apply-failed', number: 7 }));

    expect(await screen.findByText(/Ada Admin could not apply this/)).toBeInTheDocument();
    expect(screen.getByText(/Waiting on approval for Plugins\/x\/SKILL\.md/)).toBeInTheDocument();
    expect(detailMock.fetchPrDetail).toHaveBeenLastCalledWith(7, { fresh: true });
  });

  it('opened after the failure (a reload), the dialog shows the same refusal', async () => {
    detailMock.fetchPrDetail.mockResolvedValue(detail({ lastApplyFailure: FAILURE }));
    render(<ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />);
    expect(await screen.findByText(/Ada Admin could not apply this/)).toBeInTheDocument();
  });

  it('ignores another request’s failure', async () => {
    const bus = fakeBus();
    detailMock.fetchPrDetail.mockResolvedValue(detail());
    render(
      <EventBusContext.Provider value={bus.value}>
        <ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />
      </EventBusContext.Provider>,
    );
    await waitFor(() => expect(detailMock.fetchPrDetail).toHaveBeenCalledTimes(1));
    act(() => bus.emit({ kind: 'change-request-apply-failed', number: 99 }));
    expect(detailMock.fetchPrDetail).toHaveBeenCalledTimes(1);
  });
});

describe('refusalLine — what a change box says about a failed apply', () => {
  const none = new Map();

  it('a second viewer reads the persisted refusal', () => {
    expect(refusalLine({ ...CR, lastApplyFailure: FAILURE }, none)).toBe(FAILURE.reason);
  });

  it('a persisted conflict is still said in words (it never withdraws the button)', () => {
    const conflict = { ...FAILURE, conflicts: true, reason: 'This draft conflicts with the target.' };
    expect(refusalLine({ ...CR, lastApplyFailure: conflict }, none)).toBe(conflict.reason);
  });

  it("this tab's own attempt speaks first, and its conflict speaks through the blocked state", () => {
    const withStored = { ...CR, lastApplyFailure: FAILURE };
    expect(refusalLine(withStored, new Map([[7, { reason: 'mine', conflicts: false }]]))).toBe('mine');
    expect(refusalLine(withStored, new Map([[7, { reason: 'mine', conflicts: true }]]))).toBeNull();
  });

  it('nothing to say without a refusal', () => {
    expect(refusalLine(CR, none)).toBeNull();
  });
});

describe("the clicker's backstop for a lost outcome event", () => {
  const POLL_MS = 4_000;
  let restore: () => void = () => {};
  afterEach(() => restore());

  it('an apply whose merged event never arrives still completes from the state poll', async () => {
    // Hold the poll interval so the test can fire it; everything else runs for real.
    const realSet = globalThis.setInterval;
    const polls: Array<() => void> = [];
    const spy = vi.spyOn(globalThis, 'setInterval').mockImplementation(((
      fn: () => void,
      ms?: number,
      ...rest: unknown[]
    ) => {
      if (ms !== POLL_MS) return realSet(fn, ms, ...rest);
      polls.push(fn);
      return 424242;
    }) as unknown as typeof setInterval);
    restore = () => spy.mockRestore();

    const bus = fakeBus();
    const onApplied = vi.fn();
    const onFailed = vi.fn();
    detailMock.fetchPrDetail.mockResolvedValue(detail());
    mergeMock.mergePullRequest.mockResolvedValue({ status: 'merging', number: 7 });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <EventBusContext.Provider value={bus.value}>{children}</EventBusContext.Provider>
    );
    const { result } = renderHook(() => useApplyChangeRequest({ onApplied, onFailed }), { wrapper });

    act(() => result.current.apply(CR));
    await waitFor(() => expect(polls).toHaveLength(1));
    expect(result.current.activeCr).toBe(7);

    // The merge landed; its event was lost. Still open on the first poll…
    act(() => polls[0]!());
    await waitFor(() => expect(detailMock.fetchPrDetail).toHaveBeenCalledTimes(2));
    expect(onApplied).not.toHaveBeenCalled();

    // …merged on the next.
    detailMock.fetchPrDetail.mockResolvedValue(detail({ state: 'merged' }));
    act(() => polls[0]!());
    await waitFor(() => expect(onApplied).toHaveBeenCalledTimes(1));
    expect(onFailed).not.toHaveBeenCalled();
    expect(result.current.activeCr).toBeNull();
  });
});
