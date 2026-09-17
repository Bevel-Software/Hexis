import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { FileApprovalState, PullRequestSummary } from '@bevel-software/platform-shared';

/**
 * A change request shows only what its author changed, and says when it needs
 * updating. Alice proposed `price: 120`; Bob then edited `status` directly on
 * the target. Read against the target tip, Alice's request showed Bob's line
 * as a deletion — so the dialog reads the "before" side at the fork point, and
 * tells the reader separately that the target moved on, with Update.
 */

const detailMock = vi.hoisted(() => ({ fetchPrDetail: vi.fn() }));
vi.mock('../../pr/services/pr-detail.api', () => ({ fetchPrDetail: detailMock.fetchPrDetail }));

const ORIGINAL = 'price: 100\nstatus: draft\n';
const TARGET_TIP = 'price: 100\nstatus: signed\n'; // Bob's later direct edit
const PROPOSED = 'price: 120\nstatus: draft\n'; // Alice's branch
const FORK = 'f'.repeat(40);

const filesApi = vi.hoisted(() => ({
  readFileOnBranch: vi.fn(),
  readFileAtForkPoint: vi.fn(),
}));
vi.mock('../services/change-requests.api', () => filesApi);
vi.mock('../../pr/services/pr-approvals.api', () => ({
  approvePrFile: vi.fn(),
  revertPrFile: vi.fn(),
  unapprovePrFile: vi.fn(),
}));
const mergeApi = vi.hoisted(() => ({
  mergePullRequest: vi.fn(),
  refreshChangeRequestFromTarget: vi.fn(),
}));
vi.mock('../../pr/services/pr-merge.api', () => mergeApi);
vi.mock('../../pr/services/pr-cancel.api', () => ({
  cancelPullRequest: vi.fn(),
  deleteChangeRequest: vi.fn(),
}));

import { ChangeRequestDialog } from '../components/ChangeRequestDialog';
import { GitApiError } from '../../git/services/git.api';

const CR = {
  number: 21,
  title: 'Deal pricing',
  authorId: 'abc',
  author: { login: 'alice', name: 'Alice Doe' },
  appAuthor: { name: 'Alice Doe' },
  branch: 'alice/deal-pricing',
  base: 'main',
  state: 'open',
  createdAt: '2026-09-16T00:00:00.000Z',
  touchedNodePaths: ['Sales/deal.yaml'],
  review: { approvals: 0, changesRequested: 0, pendingLogins: [] },
  url: '/change-requests/21',
} as unknown as PullRequestSummary;

const approval: FileApprovalState = {
  path: 'Sales/deal.yaml',
  eligibleApprovers: { roles: ['Admin'], users: [] },
  approvedBy: [],
  inMergeGate: false,
  isApproved: false,
  viewerCanApprove: false,
};

function detail(over: Record<string, unknown> = {}) {
  return {
    ...CR,
    body: '',
    headSha: 'h'.repeat(40),
    baseSha: 'b'.repeat(40),
    files: [
      {
        path: 'Sales/deal.yaml',
        status: 'modified' as const,
        additions: 1,
        deletions: 1,
        isBinary: false,
        sha: '',
        rawUrl: '',
      },
    ],
    comments: [],
    approvals: [approval],
    mergeableInBevel: true,
    mergeBlockedReasons: [],
    mergeWarnings: [],
    viewerCanBypassMerge: false,
    viewerCanCancel: false,
    mergeBaseSha: FORK,
    behind: true,
    viewerCanUpdate: true,
    ...over,
  };
}

const NOTICE = /has changed since this was proposed/;

beforeEach(() => {
  detailMock.fetchPrDetail.mockReset();
  mergeApi.refreshChangeRequestFromTarget.mockReset();
  filesApi.readFileAtForkPoint
    .mockReset()
    .mockImplementation(async (_n: number, sha: string) => ({ content: ORIGINAL, forkSha: sha }));
  filesApi.readFileOnBranch
    .mockReset()
    .mockImplementation(async (branch: string) => (branch === 'main' ? TARGET_TIP : PROPOSED));
});

describe('ChangeRequestDialog: diff from the fork point', () => {
  it("marks only the author's change — a later edit on the target is not shown as a deletion", async () => {
    detailMock.fetchPrDetail.mockResolvedValue(detail());
    const { container } = render(
      <ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />,
    );

    await waitFor(() => expect(container.querySelector('ins')).not.toBeNull());
    const removed = [...container.querySelectorAll('del')].map((n) => n.textContent);
    const added = [...container.querySelectorAll('ins')].map((n) => n.textContent);
    expect(removed).toEqual(['price: 100']);
    expect(added).toEqual(['price: 120']);
    expect(container.textContent).not.toContain('status: signed');

    // The before-side came from the fork point, never the target tip.
    expect(filesApi.readFileAtForkPoint).toHaveBeenCalledWith(21, FORK, 'Sales/deal.yaml');
    expect(filesApi.readFileOnBranch).not.toHaveBeenCalledWith('main', 'Sales/deal.yaml');
  });
});

describe('ChangeRequestDialog: the needs-updating notice', () => {
  it('names the target and offers Update when the target has moved on', async () => {
    detailMock.fetchPrDetail.mockResolvedValue(detail());
    render(<ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />);
    const notice = await screen.findByText(NOTICE);
    expect(notice.closest('[role="status"]')?.textContent).toMatch(/^main has changed since this was proposed/);
    expect(screen.getByRole('button', { name: 'Update' })).toBeInTheDocument();
  });

  it('shows nothing when the request is up to date', async () => {
    detailMock.fetchPrDetail.mockResolvedValue(detail({ behind: false }));
    render(<ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />);
    await screen.findByText(/1 file/);
    expect(screen.queryByText(NOTICE)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Update' })).not.toBeInTheDocument();
  });

  it('a viewer who may not update sees the notice without the button', async () => {
    detailMock.fetchPrDetail.mockResolvedValue(detail({ viewerCanUpdate: false }));
    render(<ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />);
    expect(await screen.findByText(NOTICE)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Update' })).not.toBeInTheDocument();
  });

  it('Update merges on the server, re-reads the open file, and the notice disappears', async () => {
    const MERGED_FORK = 'e'.repeat(40);
    detailMock.fetchPrDetail
      .mockResolvedValueOnce(detail())
      .mockResolvedValue(detail({ behind: false, mergeBaseSha: MERGED_FORK }));
    mergeApi.refreshChangeRequestFromTarget.mockResolvedValue({});
    const { container } = render(
      <ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />,
    );
    await waitFor(() => expect(container.querySelector('ins')?.textContent).toBe('price: 120'));
    expect(filesApi.readFileOnBranch).toHaveBeenCalledTimes(1);

    // After the merge the branch carries Bob's line too, and the fork point is
    // the target tip it was merged from.
    filesApi.readFileOnBranch.mockImplementation(async () => 'price: 120\nstatus: signed\n');
    filesApi.readFileAtForkPoint.mockImplementation(async (_n: number, sha: string) => ({
      content: TARGET_TIP,
      forkSha: sha,
    }));
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(mergeApi.refreshChangeRequestFromTarget).toHaveBeenCalledWith(21));
    await waitFor(() => expect(screen.queryByText(NOTICE)).not.toBeInTheDocument());
    expect(detailMock.fetchPrDetail).toHaveBeenLastCalledWith(21, { fresh: true });

    // The open file is READ AGAIN — not left on "Loading…" — and the diff is
    // still only the author's line, now against the fresh fork point.
    await waitFor(() => expect(filesApi.readFileOnBranch).toHaveBeenCalledTimes(2));
    expect(filesApi.readFileAtForkPoint).toHaveBeenCalledWith(21, MERGED_FORK, 'Sales/deal.yaml');
    await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument());
    await waitFor(() =>
      expect([...container.querySelectorAll('del')].map((n) => n.textContent)).toEqual(['price: 100']),
    );
    expect([...container.querySelectorAll('ins')].map((n) => n.textContent)).toEqual(['price: 120']);
  });

  it('a branch read still in flight when Update lands never overwrites the re-read', async () => {
    const MERGED_FORK = 'e'.repeat(40);
    detailMock.fetchPrDetail
      .mockResolvedValueOnce(detail())
      .mockResolvedValue(detail({ behind: false, mergeBaseSha: MERGED_FORK }));
    mergeApi.refreshChangeRequestFromTarget.mockResolvedValue({});
    let releaseStale: (text: string) => void = () => {};
    filesApi.readFileOnBranch.mockImplementationOnce(
      () => new Promise<string>((resolve) => (releaseStale = resolve)),
    );
    const { container } = render(
      <ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />,
    );
    await waitFor(() => expect(filesApi.readFileOnBranch).toHaveBeenCalledTimes(1));

    filesApi.readFileOnBranch.mockImplementation(async () => 'price: 125\nstatus: signed\n');
    filesApi.readFileAtForkPoint.mockImplementation(async (_n: number, sha: string) => ({
      content: TARGET_TIP,
      forkSha: sha,
    }));
    fireEvent.click(await screen.findByRole('button', { name: 'Update' }));
    await waitFor(() => expect(container.querySelector('ins')?.textContent).toBe('price: 125'));

    // The pre-update read finally answers — and lands on nothing.
    releaseStale(PROPOSED);
    await new Promise((r) => setTimeout(r, 20));
    expect([...container.querySelectorAll('ins')].map((n) => n.textContent)).toEqual(['price: 125']);
  });

  it('a merge that succeeds but cannot be reloaded says so, and still re-reads the open file', async () => {
    detailMock.fetchPrDetail.mockResolvedValueOnce(detail()).mockRejectedValue(new Error('503'));
    mergeApi.refreshChangeRequestFromTarget.mockResolvedValue({});
    const { container } = render(
      <ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />,
    );
    await waitFor(() => expect(container.querySelector('ins')?.textContent).toBe('price: 120'));

    filesApi.readFileOnBranch.mockImplementation(async () => 'price: 125\nstatus: draft\n');
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    expect(await screen.findByText(/Updated, but couldn't reload this change request/)).toBeInTheDocument();
    await waitFor(() => expect(filesApi.readFileOnBranch).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(container.querySelector('ins')?.textContent).toBe('price: 125'));
  });

  it('a conflicting Update shows the conflict help with the prompt for the agent', async () => {
    detailMock.fetchPrDetail.mockResolvedValue(detail());
    mergeApi.refreshChangeRequestFromTarget.mockRejectedValue(
      new GitApiError(409, 'Conflicts merging "main" into "alice/deal-pricing".', {
        kind: 'change-request-conflicts',
        conflictedPaths: ['Sales/deal.yaml'],
        error: 'Conflicts',
      }),
    );
    render(<ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Update' }));
    expect(await screen.findByText(/Fastest fix: ask your agent to resolve it/)).toBeInTheDocument();
    expect(screen.getByText(/Change request #21 can no longer be applied/)).toBeInTheDocument();
    // The branch is unchanged, so the notice stays — without a button that
    // would only fail the same way again.
    expect(screen.getByText(NOTICE)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Update' })).not.toBeInTheDocument();
    expect(detailMock.fetchPrDetail).toHaveBeenCalledTimes(1);
  });

  it('any other Update failure is reported, and Update stays available', async () => {
    detailMock.fetchPrDetail.mockResolvedValue(detail());
    mergeApi.refreshChangeRequestFromTarget.mockRejectedValue(
      new GitApiError(403, 'Only the author of this change request, or someone who may apply it, can update it.'),
    );
    render(<ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Update' }));
    expect(await screen.findByText(/Only the author of this change request/)).toBeInTheDocument();
    expect(screen.queryByText(/Fastest fix/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Update' })).toBeInTheDocument();
  });
});
