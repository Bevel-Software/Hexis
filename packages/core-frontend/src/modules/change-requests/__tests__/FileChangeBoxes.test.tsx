import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import type { PullRequestSummary, WorkflowEvent } from '@bevel-software/platform-shared';
import { EventBusContext, type EventBusContextValue } from '../../workflow/state/event-bus.context';
import {
  OpenChangeRequestsContext,
  NO_CHANGE_REQUESTS,
} from '../../workspace/state/open-change-requests.context';

/**
 * The file page's proposal boxes. Approval rights come from the FILE, not from
 * authorship: an eligible approver who wrote a proposal decides it like any
 * other, and keeps Withdraw beside the verdicts.
 */

const api = vi.hoisted(() => ({
  readFileOnBranch: vi.fn(),
  readFileAtForkPoint: vi.fn(),
  fetchPrDetail: vi.fn(),
  approvePrFile: vi.fn(),
  mergePullRequest: vi.fn(),
  cancelPullRequest: vi.fn(),
}));
vi.mock('../services/change-requests.api', () => ({
  readFileOnBranch: api.readFileOnBranch,
  readFileAtForkPoint: api.readFileAtForkPoint,
}));
vi.mock('../../pr/services/pr-detail.api', () => ({ fetchPrDetail: api.fetchPrDetail }));
vi.mock('../../pr/services/pr-approvals.api', () => ({ approvePrFile: api.approvePrFile }));
vi.mock('../../pr/services/pr-merge.api', () => ({ mergePullRequest: api.mergePullRequest }));
vi.mock('../../pr/services/pr-cancel.api', () => ({ cancelPullRequest: api.cancelPullRequest }));

import { FileChangeBoxes } from '../components/FileChangeBoxes';
import { othersPendingBesides, waitingOnViewerLabel } from '../utils/author';

const PATH = 'Docs/guide.md';

const CR: PullRequestSummary = {
  number: 31,
  title: 'Tighten the guide',
  author: { login: 'user-abc', name: 'Bevel Bot' },
  appAuthor: { name: 'Olga' },
  branch: 'olga/guide',
  base: 'main',
  state: 'open',
  createdAt: '2026-09-01T00:00:00.000Z',
  touchedNodePaths: [PATH],
  review: { approvals: 0, changesRequested: 0, pendingLogins: [] },
  url: '/change-requests/31',
} as unknown as PullRequestSummary;

function makeFakeBus() {
  const handlers: Record<string, ((e: WorkflowEvent) => void)[]> = {};
  const bus: EventBusContextValue & { emit(e: WorkflowEvent): void } = {
    subscribe(kind, handler) {
      (handlers[kind] ??= []).push(handler as (e: WorkflowEvent) => void);
      return () => {
        handlers[kind] = (handlers[kind] ?? []).filter((h) => h !== handler);
      };
    },
    setFocus() {},
    watchWorkspace() {
      return () => {};
    },
    emit(e) {
      (handlers[e.kind] ?? []).forEach((h) => h(e));
    },
  };
  return bus;
}

function renderBoxes(opts: { mine: boolean; canDecide: boolean; othersPending?: number }) {
  const bus = makeFakeBus();
  render(
    <EventBusContext.Provider value={bus}>
      <OpenChangeRequestsContext.Provider
        value={{ ...NO_CHANGE_REQUESTS, mineNumbers: new Set(opts.mine ? [CR.number] : []) }}
      >
        <FileChangeBoxes
          repoRelativePath={PATH}
          requests={[CR]}
          canDecide={opts.canDecide}
          ownersLabel="Docs"
          othersPending={opts.othersPending}
          onApplied={() => {}}
        />
      </OpenChangeRequestsContext.Provider>
    </EventBusContext.Provider>,
  );
  return bus;
}

beforeEach(() => {
  vi.clearAllMocks();
  api.readFileOnBranch.mockImplementation(async (branch: string) =>
    branch === CR.branch ? 'new line\n' : 'old line\n',
  );
  // The box's "before" side is the request's fork point, not main's tip.
  api.readFileAtForkPoint.mockResolvedValue({ content: 'old line\n', forkSha: 'f'.repeat(40) });
  api.fetchPrDetail.mockResolvedValue({
    ...CR,
    state: 'open',
    approvals: [
      {
        path: PATH,
        eligibleApprovers: { roles: ['Docs'], users: [] },
        approvedBy: [],
        isApproved: false,
        // An owned markdown file: the merge gate binds it, so Apply approves it.
        inMergeGate: true,
        viewerCanApprove: true,
      },
    ],
  });
  api.approvePrFile.mockResolvedValue([]);
  api.mergePullRequest.mockResolvedValue(undefined);
  api.cancelPullRequest.mockResolvedValue(undefined);
});

describe('FileChangeBoxes: who may decide', () => {
  it('offers an approver who wrote the proposal Approve, Decline and Withdraw', async () => {
    renderBoxes({ mine: true, canDecide: true, othersPending: 0 });

    expect(await screen.findByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Decline' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Withdraw' })).toBeInTheDocument();
    expect(screen.getByText('You')).toBeInTheDocument();
  });

  it('offers an author without approval rights only Withdraw', async () => {
    renderBoxes({ mine: true, canDecide: false, othersPending: 0 });

    expect(await screen.findByRole('button', { name: 'Withdraw' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Decline' })).not.toBeInTheDocument();
    expect(screen.getByText('Waiting on Docs')).toBeInTheDocument();
  });

  it('offers an approver who did not write it the verdicts but not Withdraw', async () => {
    renderBoxes({ mine: false, canDecide: true, othersPending: 0 });

    expect(await screen.findByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Decline' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Withdraw' })).not.toBeInTheDocument();
  });

  it('applies an author-approver’s own proposal like the dialog’s Apply, with the same banner', async () => {
    const bus = renderBoxes({ mine: true, canDecide: true, othersPending: 0 });

    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));

    await waitFor(() => expect(api.approvePrFile).toHaveBeenCalledWith(CR.number, PATH));
    await waitFor(() => expect(api.mergePullRequest).toHaveBeenCalledWith(CR.number));
    expect(api.fetchPrDetail).toHaveBeenCalledWith(CR.number, { fresh: true });

    act(() => {
      bus.emit({ kind: 'change-request-merged', number: CR.number } as unknown as WorkflowEvent);
    });
    expect(
      await screen.findByText('Applied: the file now reads with that change.'),
    ).toBeInTheDocument();
  });
});

describe('FileChangeBoxes: the waiting label', () => {
  it('reads "Waiting on you" when the viewer is the only pending approver', async () => {
    renderBoxes({ mine: true, canDecide: true, othersPending: 0 });
    expect(await screen.findByText('Waiting on you')).toBeInTheDocument();
  });

  it('reads "Waiting on you and N others" when more are pending', async () => {
    renderBoxes({ mine: false, canDecide: true, othersPending: 2 });
    expect(await screen.findByText('Waiting on you and 2 others')).toBeInTheDocument();
  });
});

describe('waiting-label helpers', () => {
  it('pluralises the others', () => {
    expect(waitingOnViewerLabel(0)).toBe('Waiting on you');
    expect(waitingOnViewerLabel(1)).toBe('Waiting on you and 1 other');
    expect(waitingOnViewerLabel(3)).toBe('Waiting on you and 3 others');
  });

  it('counts every approver except the viewer’s own grant', () => {
    const approvers = {
      roles: ['Docs'],
      users: [
        { name: 'Me', email: 'Me@Example.com' },
        { name: 'Ali', email: 'ali@example.com' },
      ],
    };
    expect(othersPendingBesides(approvers, 'me@example.com')).toBe(2);
    expect(othersPendingBesides({ roles: [], users: [approvers.users[0]] }, 'me@example.com')).toBe(0);
    // No user grant of the viewer's own: they decide through the role.
    expect(othersPendingBesides(approvers, null)).toBe(2);
  });

  it('credits one role to a viewer who decides through a role', () => {
    // The Admin-only file: an Admin viewer is the sole pending grant.
    expect(othersPendingBesides({ roles: ['Admin'], users: [] }, 'admin@example.com')).toBe(0);
    expect(
      othersPendingBesides(
        { roles: ['Admin', 'Docs'], users: [{ email: 'ali@example.com' }] },
        'admin@example.com',
      ),
    ).toBe(2);
  });
});
