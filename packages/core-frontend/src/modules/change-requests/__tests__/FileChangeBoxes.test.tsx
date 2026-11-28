import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import type { PullRequestSummary, VersionControlEvent } from '@bevel-software/platform-shared';
import type { useEventBus } from '../../version-control';

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
  revertPrFile: vi.fn(),
  mergePullRequest: vi.fn(),
  cancelPullRequest: vi.fn(),
}));
vi.mock('../services/change-requests.api', () => ({
  readFileOnBranch: api.readFileOnBranch,
  readFileAtForkPoint: api.readFileAtForkPoint,
}));
// The pr module through its entry, as the components import it: the calls these boxes make are faked, the rest is real.
vi.mock('../../pr', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../pr')>()),
  fetchPrDetail: api.fetchPrDetail,
  approvePrFile: api.approvePrFile,
  revertPrFile: api.revertPrFile,
  mergePullRequest: api.mergePullRequest,
  cancelPullRequest: api.cancelPullRequest,
}));
// What the boxes ask the app around them, stubbed at the public hooks they call: the event bus the apply listens on,
// and which open requests are the viewer's own.
const around = vi.hoisted(() => ({ bus: null as unknown, mineNumbers: new Set<number>() }));
vi.mock('../../version-control', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../version-control')>()),
  useEventBus: () => around.bus,
}));
vi.mock('../../workspace', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../workspace')>()),
  useOpenChangeRequests: () => ({ paths: new Set<string>(), forPath: () => [], minePaths: new Map<string, number>(), mineNumbers: around.mineNumbers }),
}));

import { FileChangeBoxes } from '../components/FileChangeBoxes';
import { othersPendingBesides, waitingOnViewerLabel } from '../utils/author';
import { PR_STALE_EVENT } from '../../../core/events';

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
  const handlers: Record<string, ((e: VersionControlEvent) => void)[]> = {};
  const bus: NonNullable<ReturnType<typeof useEventBus>> & { emit(e: VersionControlEvent): void } = {
    subscribe(kind, handler) {
      (handlers[kind] ??= []).push(handler as (e: VersionControlEvent) => void);
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
  around.bus = bus;
  around.mineNumbers = new Set(opts.mine ? [CR.number] : []);
  render(
    <FileChangeBoxes
      repoRelativePath={PATH}
      requests={[CR]}
      canDecide={opts.canDecide}
      ownersLabel="Docs"
      othersPending={opts.othersPending}
      onApplied={() => {}}
    />,
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
  api.revertPrFile.mockResolvedValue({ closed: false, remainingPaths: ['Docs/other.md'] });
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
      bus.emit({ kind: 'change-request-merged', number: CR.number } as unknown as VersionControlEvent);
    });
    expect(
      await screen.findByText('Published: the file now reads with that change.'),
    ).toBeInTheDocument();
  });
});

describe('FileChangeBoxes: Decline and Withdraw', () => {
  it('Decline reverts only THIS file and does not cancel the request', async () => {
    renderBoxes({ mine: false, canDecide: true, othersPending: 0 });

    fireEvent.click(await screen.findByRole('button', { name: 'Decline' }));

    await waitFor(() => expect(api.revertPrFile).toHaveBeenCalledWith(CR.number, PATH));
    expect(api.cancelPullRequest).not.toHaveBeenCalled();
  });

  it('a Decline the server refuses says so', async () => {
    api.revertPrFile.mockRejectedValue(new Error('You may not decline this file.'));
    renderBoxes({ mine: false, canDecide: true, othersPending: 0 });

    fireEvent.click(await screen.findByRole('button', { name: 'Decline' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('You may not decline this file.');
  });

  it("Withdraw is still the author's take-back of the whole request", async () => {
    renderBoxes({ mine: true, canDecide: false, othersPending: 0 });

    fireEvent.click(await screen.findByRole('button', { name: 'Withdraw' }));

    await waitFor(() => expect(api.cancelPullRequest).toHaveBeenCalledWith(CR.number));
    expect(api.revertPrFile).not.toHaveBeenCalled();
  });
});

describe('FileChangeBoxes: what the whole-change dialog settled', () => {
  /** The request's detail as the dialog reads it: one file, the viewer's to approve, approved already or not. */
  const fullDetail = (isApproved = false) => ({
    ...CR,
    body: '',
    headSha: 'h',
    baseSha: 'b',
    files: [{ path: PATH, status: 'modified' as const, additions: 1, deletions: 1, isBinary: false, sha: '', rawUrl: '' }],
    approvals: [{ path: PATH, eligibleApprovers: { roles: ['Docs'], users: [] }, approvedBy: [], isApproved, inMergeGate: true, viewerCanApprove: true }],
    mergeableInBevel: true,
    mergeBlockedReasons: [],
    mergeWarnings: [],
    viewerCanBypassMerge: false,
    viewerCanCancel: false,
  });

  it('says Published when the dialog applied the request', async () => {
    api.fetchPrDetail.mockResolvedValue(fullDetail(true));
    const bus = renderBoxes({ mine: false, canDecide: true, othersPending: 0 });

    fireEvent.click(await screen.findByRole('button', { name: 'Read the whole change' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Apply changes' }));
    await waitFor(() => expect(api.mergePullRequest).toHaveBeenCalledWith(CR.number));
    act(() => {
      bus.emit({ kind: 'change-request-merged', number: CR.number } as unknown as VersionControlEvent);
    });

    expect(await screen.findByText('Published: the file now reads with that change.')).toBeInTheDocument();
  });

  it('says nothing was published when the dialog closed the request by declining its last file', async () => {
    api.fetchPrDetail.mockResolvedValue(fullDetail());
    api.revertPrFile.mockResolvedValue({ closed: true, remainingPaths: [] });
    const stale = vi.fn();
    window.addEventListener(PR_STALE_EVENT, stale);
    renderBoxes({ mine: false, canDecide: true, othersPending: 0 });

    fireEvent.click(await screen.findByRole('button', { name: 'Read the whole change' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Decline this file' }));
    fireEvent.click(screen.getByRole('button', { name: 'Really decline this file?' }));

    await waitFor(() => expect(api.revertPrFile).toHaveBeenCalledWith(CR.number, PATH));
    // The dialog is gone and the lists are told to refresh, but nothing claims the change landed.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Really decline this file?' })).not.toBeInTheDocument());
    expect(stale).toHaveBeenCalled();
    expect(screen.queryByText('Published: the file now reads with that change.')).not.toBeInTheDocument();
    expect(api.mergePullRequest).not.toHaveBeenCalled();
    window.removeEventListener(PR_STALE_EVENT, stale);
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
