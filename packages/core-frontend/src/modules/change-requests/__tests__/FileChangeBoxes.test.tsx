import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import type { PullRequestSummary, VersionControlEvent } from '@bevel-software/platform-shared';
import type { useEventBus } from '../../version-control';
import type { useOpenChangeRequests } from '../../workspace';

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
// The pull-request calls, at the pr module's entry: where the boxes and the
// apply hook import them from.
vi.mock('../../pr', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../pr')>()),
  fetchPrDetail: api.fetchPrDetail,
  approvePrFile: api.approvePrFile,
  mergePullRequest: api.mergePullRequest,
  cancelPullRequest: api.cancelPullRequest,
}));

type Bus = NonNullable<ReturnType<typeof useEventBus>>;
type OpenRequests = ReturnType<typeof useOpenChangeRequests>;

/**
 * What the boxes read of their surroundings, through the entries they read it
 * from: the server's event bus (version control's `useEventBus`) and the
 * caller's own open requests (workspace's `useOpenChangeRequests`). Each
 * render sets both; everything else those modules offer stays their own.
 */
const seams = vi.hoisted(() => ({ bus: null as unknown, openRequests: null as unknown }));
vi.mock('../../version-control', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../version-control')>()),
  useEventBus: () => seams.bus,
}));
vi.mock('../../workspace', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../workspace')>()),
  useOpenChangeRequests: () => seams.openRequests,
}));

function openRequests(mineNumbers: number[] = []): OpenRequests {
  return { paths: new Set(), forPath: () => [], minePaths: new Map(), mineNumbers: new Set(mineNumbers) };
}

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
  const handlers: Record<string, ((e: VersionControlEvent) => void)[]> = {};
  const bus: Bus & { emit(e: VersionControlEvent): void } = {
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
  seams.bus = bus;
  seams.openRequests = openRequests(opts.mine ? [CR.number] : []);
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

describe('FileChangeBoxes: Approve binds the file on screen', () => {
  const OTHER = 'Locked/gamma.md';
  const approval = (path: string, isApproved: boolean) => ({
    path,
    eligibleApprovers: { roles: ['Admin'], users: [] },
    approvedBy: [],
    isApproved,
    inMergeGate: true,
    viewerCanApprove: true,
  });

  beforeEach(() => {
    api.fetchPrDetail.mockResolvedValue({
      ...CR,
      state: 'open',
      approvals: [approval(PATH, false), approval(OTHER, false)],
    });
  });

  it('approves only this file of a two-file request and leaves the request unapplied', async () => {
    api.approvePrFile.mockResolvedValue([approval(PATH, true), approval(OTHER, false)]);
    renderBoxes({ mine: true, canDecide: true, othersPending: 0 });

    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));

    expect(await screen.findByText('Waiting on other files')).toBeInTheDocument();
    expect(screen.getByText('When you last pressed, 1 other file still needed approval.')).toBeInTheDocument();
    expect(api.approvePrFile).toHaveBeenCalledTimes(1);
    expect(api.approvePrFile).toHaveBeenCalledWith(CR.number, PATH);
    expect(api.approvePrFile).not.toHaveBeenCalledWith(CR.number, OTHER);
    expect(api.mergePullRequest).not.toHaveBeenCalled();
    expect(screen.queryByText('Published: the file now reads with that change.')).not.toBeInTheDocument();
  });

  /**
   * The note records a press; it never withholds the button. Another viewer
   * may approve the other file meanwhile and this tab hears nothing of it, so
   * the next press reads the server again and applies.
   */
  it('applies on the next press once the other file was approved elsewhere', async () => {
    api.approvePrFile.mockResolvedValue([approval(PATH, true), approval(OTHER, false)]);
    renderBoxes({ mine: true, canDecide: true, othersPending: 0 });
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    await screen.findByText('Waiting on other files');

    api.fetchPrDetail.mockResolvedValue({
      ...CR,
      state: 'open',
      approvals: [approval(PATH, true), approval(OTHER, true)],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() => expect(api.mergePullRequest).toHaveBeenCalledWith(CR.number));
    expect(api.approvePrFile).toHaveBeenCalledTimes(1);
  });

  /** The note belongs to the file it was pressed on, not to the request. */
  it('keeps the note off another file of the same request', async () => {
    api.approvePrFile.mockResolvedValue([approval(PATH, true), approval(OTHER, false)]);
    const both = { ...CR, touchedNodePaths: [PATH, OTHER] } as PullRequestSummary;
    seams.bus = makeFakeBus();
    seams.openRequests = openRequests();
    const tree = (path: string) => (
      <FileChangeBoxes
        repoRelativePath={path}
        requests={[both]}
        canDecide
        ownersLabel="Docs"
        onApplied={() => {}}
      />
    );
    const { rerender } = render(tree(PATH));
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    await screen.findByText('Waiting on other files');

    rerender(tree(OTHER));

    expect(await screen.findByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(screen.getByText('Pending approval')).toBeInTheDocument();
    expect(screen.queryByText('Waiting on other files')).not.toBeInTheDocument();
  });

  /** A file the gate does not bind gets no approval record, as in the dialog. */
  it('records no approval on a file outside the merge gate', async () => {
    api.fetchPrDetail.mockResolvedValue({
      ...CR,
      state: 'open',
      approvals: [{ ...approval(PATH, false), inMergeGate: false }, approval(OTHER, true)],
    });
    renderBoxes({ mine: true, canDecide: true, othersPending: 0 });

    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));

    await waitFor(() => expect(api.mergePullRequest).toHaveBeenCalledWith(CR.number));
    expect(api.approvePrFile).not.toHaveBeenCalled();
  });

  it('applies when this file was the last one the request waited on', async () => {
    api.fetchPrDetail.mockResolvedValue({
      ...CR,
      state: 'open',
      approvals: [approval(PATH, false), approval(OTHER, true)],
    });
    api.approvePrFile.mockResolvedValue([approval(PATH, true), approval(OTHER, true)]);
    renderBoxes({ mine: true, canDecide: true, othersPending: 0 });

    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));

    await waitFor(() => expect(api.mergePullRequest).toHaveBeenCalledWith(CR.number));
    expect(api.approvePrFile).toHaveBeenCalledTimes(1);
    expect(api.approvePrFile).toHaveBeenCalledWith(CR.number, PATH);
  });

  it('neither re-approves an approved file nor applies while another file waits', async () => {
    api.fetchPrDetail.mockResolvedValue({
      ...CR,
      state: 'open',
      approvals: [approval(PATH, true), approval(OTHER, false)],
    });
    renderBoxes({ mine: true, canDecide: true, othersPending: 0 });

    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));

    expect(await screen.findByText('When you last pressed, 1 other file still needed approval.')).toBeInTheDocument();
    expect(api.approvePrFile).not.toHaveBeenCalled();
    expect(api.mergePullRequest).not.toHaveBeenCalled();
  });

  it('reports a refused approval of this file instead of applying anyway', async () => {
    api.approvePrFile.mockRejectedValue(new Error('You may not approve Docs/guide.md'));
    renderBoxes({ mine: true, canDecide: true, othersPending: 0 });

    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('You may not approve');
    expect(api.mergePullRequest).not.toHaveBeenCalled();
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
