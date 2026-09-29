import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { FileApprovalState, PullRequestSummary } from '@bevel-software/platform-shared';

/**
 * A change request shows only what its author changed. Alice proposed
 * `price: 120`; Bob then edited `status` directly on the target. Read against
 * the target tip, Alice's request showed Bob's line as a deletion — so the
 * dialog reads the "before" side at the fork point.
 *
 * Which fork point, once a stale request brings itself up to date on open, is
 * the other half of this: the merge MOVES the fork point, so every read has to
 * wait for it and then read the one the merge left.
 */

const detailMock = vi.hoisted(() => ({ fetchPrDetail: vi.fn() }));
vi.mock('../../pr/services/pr-detail.api', () => ({ fetchPrDetail: detailMock.fetchPrDetail }));

const ORIGINAL = 'price: 100\nstatus: draft\n';
const TARGET_TIP = 'price: 100\nstatus: signed\n'; // Bob's later direct edit
const PROPOSED = 'price: 120\nstatus: draft\n'; // Alice's branch
const FORK = 'f'.repeat(40);
const MERGED_FORK = 'e'.repeat(40);

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
    needsUpdate: true,
    updatedPaths: ['Sales/deal.yaml'],
    viewerCanUpdate: true,
    ...over,
  };
}

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
    // A READER: the request stays behind under them (nobody brings it up to
    // date by looking at it), which is exactly the state the fork-point read
    // exists for.
    detailMock.fetchPrDetail.mockResolvedValue(detail({ viewerCanUpdate: false }));
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

  it('a request that is up to date reads its files straight away, against its own fork point', async () => {
    detailMock.fetchPrDetail.mockResolvedValue(detail({ behind: false, needsUpdate: false }));
    const { container } = render(
      <ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />,
    );

    await waitFor(() => expect(container.querySelector('ins')).not.toBeNull());
    expect(mergeApi.refreshChangeRequestFromTarget).not.toHaveBeenCalled();
    expect(filesApi.readFileAtForkPoint).toHaveBeenCalledWith(21, FORK, 'Sales/deal.yaml');
    expect([...container.querySelectorAll('del')].map((n) => n.textContent)).toEqual(['price: 100']);
    expect([...container.querySelectorAll('ins')].map((n) => n.textContent)).toEqual(['price: 120']);
  });
});

describe('ChangeRequestDialog: the files after the request brings itself up to date', () => {
  it("re-reads the open file against the fresh fork point, and still marks only the author's line", async () => {
    // The merge moves the fork point, so the file the reader is looking at is
    // read a second time — against the commit the merge left. The FIRST read,
    // at the old fork point, is not a mistake: it is what puts the proposal on
    // screen immediately, and it describes what the author started from
    // exactly as truthfully until the merge lands.
    detailMock.fetchPrDetail.mockResolvedValue(detail());
    mergeApi.refreshChangeRequestFromTarget.mockResolvedValue(
      detail({ behind: false, needsUpdate: false, mergeBaseSha: MERGED_FORK }),
    );
    // After the merge the branch carries Bob's line too, and the fork point is
    // the target tip it was merged from.
    filesApi.readFileOnBranch.mockImplementation(async () => 'price: 120\nstatus: signed\n');
    filesApi.readFileAtForkPoint.mockImplementation(async (_n: number, sha: string) => ({
      content: TARGET_TIP,
      forkSha: sha,
    }));

    const { container } = render(
      <ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />,
    );

    await waitFor(() => expect(mergeApi.refreshChangeRequestFromTarget).toHaveBeenCalledWith(21));
    await waitFor(() =>
      expect(filesApi.readFileAtForkPoint).toHaveBeenCalledWith(21, MERGED_FORK, 'Sales/deal.yaml'),
    );
    await waitFor(() => expect(container.querySelector('ins')).not.toBeNull());
    // The update's own answer is the fresh detail; there is no second read.
    expect(detailMock.fetchPrDetail).toHaveBeenCalledTimes(1);
    // The proposal is still the author's line alone, read against the fork
    // point the merge left.
    expect([...container.querySelectorAll('del')].map((n) => n.textContent)).toEqual(['price: 100']);
    expect([...container.querySelectorAll('ins')].map((n) => n.textContent)).toEqual(['price: 120']);
    await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument());
  });

  it('shows the file against the OLD fork point before the update lands', async () => {
    // What the reader gets for free now: the diff, immediately, while the
    // merge runs behind it.
    let land: (v: unknown) => void = () => {};
    mergeApi.refreshChangeRequestFromTarget.mockImplementation(
      () => new Promise((resolve) => (land = resolve)),
    );
    detailMock.fetchPrDetail.mockResolvedValue(detail());

    const { container } = render(
      <ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />,
    );

    await waitFor(() => expect(container.querySelector('ins')?.textContent).toBe('price: 120'));
    expect(filesApi.readFileAtForkPoint).toHaveBeenCalledWith(21, FORK, 'Sales/deal.yaml');
    land(detail({ behind: false, needsUpdate: false, mergeBaseSha: MERGED_FORK }));
    await waitFor(() =>
      expect(filesApi.readFileAtForkPoint).toHaveBeenCalledWith(21, MERGED_FORK, 'Sales/deal.yaml'),
    );
  });
});
