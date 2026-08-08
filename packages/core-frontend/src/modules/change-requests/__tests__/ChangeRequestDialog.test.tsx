import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type { FileApprovalState, PullRequestSummary } from '@bevel-software/platform-shared';

/**
 * The dialog's degenerate state: a request whose detail reports ZERO files.
 * Real on dev — a branch whose changes have since landed on the target (or
 * whose only change was roles.yaml, which the review surface filters). The
 * old rendering was a blank file pill over an eternal "Loading…", which reads
 * as a hang; the dialog must state the truth and withdraw the Apply button.
 */

const detailMock = vi.hoisted(() => ({ fetchPrDetail: vi.fn() }));
vi.mock('../../pr/services/pr-detail.api', () => ({ fetchPrDetail: detailMock.fetchPrDetail }));

vi.mock('../services/change-requests.api', () => ({
  readFileOnBranch: vi.fn(async () => 'branch copy'),
}));
const approvalsApi = vi.hoisted(() => ({ approvePrFile: vi.fn(), revertPrFile: vi.fn() }));
vi.mock('../../pr/services/pr-approvals.api', () => ({
  approvePrFile: approvalsApi.approvePrFile,
  revertPrFile: approvalsApi.revertPrFile,
  unapprovePrFile: vi.fn(),
}));
vi.mock('../../pr/services/pr-merge.api', () => ({ mergePullRequest: vi.fn() }));
const cancelApi = vi.hoisted(() => ({ deleteChangeRequest: vi.fn() }));
vi.mock('../../pr/services/pr-cancel.api', () => ({
  cancelPullRequest: vi.fn(),
  deleteChangeRequest: cancelApi.deleteChangeRequest,
}));

import { ChangeRequestDialog } from '../components/ChangeRequestDialog';

const CR: PullRequestSummary = {
  number: 12,
  title: 'Customer hypotheses — 2026-07-31 – 2026-08-06',
  authorId: 'abc',
  author: { login: 'user-abc', name: 'Ali' },
  appAuthor: { name: 'Ali' },
  branch: 'ali.raza/customer-hypotheses-2026-08-07',
  base: 'main',
  state: 'open',
  createdAt: '2026-08-07T00:00:00.000Z',
  touchedNodePaths: [],
  review: { approvals: 0, changesRequested: 0, pendingLogins: [] },
  url: '/change-requests/12',
} as unknown as PullRequestSummary;

beforeEach(() => {
  detailMock.fetchPrDetail.mockReset();
});

describe('ChangeRequestDialog: a request with no remaining changes', () => {
  it('says so instead of a blank pill over an eternal Loading, and hides Apply', async () => {
    detailMock.fetchPrDetail.mockResolvedValue({
      ...CR,
      body: '',
      headSha: 'h',
      baseSha: 'b',
      files: [],
      comments: [],
      approvals: [],
      mergeableInBevel: true,
      mergeBlockedReasons: [],
      mergeWarnings: [],
      viewerCanBypassMerge: false,
      viewerCanCancel: true,
    });
    render(<ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />);

    expect(
      await screen.findByText(/doesn't change anything anymore/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Apply changes' })).not.toBeInTheDocument();
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
    expect(screen.queryByText(/not touched by this request/)).not.toBeInTheDocument();
  });

  it('still renders the normal grid while the detail is loading', () => {
    detailMock.fetchPrDetail.mockReturnValue(new Promise(() => {}));
    render(<ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />);
    // No premature "changes nothing" claim before the detail answers.
    expect(screen.queryByText(/doesn't change anything anymore/)).not.toBeInTheDocument();
  });
});

const approval = (over: Partial<FileApprovalState>): FileApprovalState => ({
  path: 'Docs/a.md',
  eligibleApprovers: { roles: ['Admin'], users: [] },
  approvedBy: [],
  isApproved: false,
  viewerCanApprove: false,
  ...over,
});

function detailWith(approvals: FileApprovalState[]) {
  return {
    ...CR,
    body: '',
    headSha: 'h',
    baseSha: 'b',
    files: approvals.map((a) => ({
      path: a.path,
      status: 'modified' as const,
      additions: 1,
      deletions: 0,
      isBinary: false,
      sha: '',
      rawUrl: '',
    })),
    comments: [],
    approvals,
    mergeableInBevel: true,
    mergeBlockedReasons: [],
    mergeWarnings: ['Waiting on approval for Docs/a.md from Admin.'],
    viewerCanBypassMerge: false,
    viewerCanCancel: false,
  };
}

describe('ChangeRequestDialog: the apply gate and the per-file verbs', () => {
  it('hides Apply when a file is neither approved nor approvable by the viewer', async () => {
    detailMock.fetchPrDetail.mockResolvedValue(
      detailWith([approval({ viewerCanApprove: false, isApproved: false })]),
    );
    render(<ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />);
    // The waiting line takes the button's place — naming who is being waited on.
    expect(await screen.findByText(/Waiting on approval for Docs\/a\.md/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Apply changes' })).not.toBeInTheDocument();
  });

  it('all files approved → plain Apply; approvable-but-unapproved → Bypass approval and apply', async () => {
    detailMock.fetchPrDetail.mockResolvedValue(
      detailWith([
        approval({ path: 'Docs/a.md', isApproved: true }),
        approval({ path: 'Docs/b.md', viewerCanApprove: true }),
      ]),
    );
    const first = render(<ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />);
    // One file still needs an approval the viewer's write access can cover —
    // the button says what the click actually does.
    expect(
      await screen.findByRole('button', { name: 'Bypass approval and apply' }),
    ).toBeInTheDocument();
    first.unmount();

    detailMock.fetchPrDetail.mockResolvedValue(
      detailWith([
        approval({ path: 'Docs/a.md', isApproved: true }),
        approval({ path: 'Docs/b.md', isApproved: true }),
      ]),
    );
    render(<ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />);
    expect(await screen.findByRole('button', { name: 'Apply changes' })).toBeInTheDocument();
  });

  it('the tree checkbox approves in one click, and unapproves on the next', async () => {
    detailMock.fetchPrDetail.mockResolvedValue(
      detailWith([approval({ viewerCanApprove: true })]),
    );
    approvalsApi.approvePrFile.mockResolvedValue([
      approval({ viewerCanApprove: true, isApproved: true }),
    ]);
    render(<ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve Docs/a.md' }));
    expect(approvalsApi.approvePrFile).toHaveBeenCalledWith(12, 'Docs/a.md');
    // Approved: the same control now offers the takeback.
    expect(await screen.findByRole('button', { name: 'Unapprove Docs/a.md' })).toBeInTheDocument();
  });

  it('right-click reverts, with its own confirm; the last file resolves the dialog', async () => {
    detailMock.fetchPrDetail.mockResolvedValue(
      detailWith([approval({ viewerCanApprove: true })]),
    );
    approvalsApi.revertPrFile.mockResolvedValue({ closed: true, remainingPaths: [] });
    const onResolved = vi.fn();
    render(<ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={onResolved} />);

    fireEvent.contextMenu(await screen.findByTitle('Docs/a.md'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Revert file…' }));
    // Nothing sent yet — the armed second click is the verdict.
    expect(approvalsApi.revertPrFile).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Really revert this file?' }));

    await waitFor(() => expect(approvalsApi.revertPrFile).toHaveBeenCalledWith(12, 'Docs/a.md'));
    await waitFor(() => expect(onResolved).toHaveBeenCalled());
  });

  it('Delete request appears for admins only, arms, then deletes and resolves', async () => {
    detailMock.fetchPrDetail.mockResolvedValue({
      ...detailWith([approval({})]),
      viewerCanBypassMerge: true,
    });
    cancelApi.deleteChangeRequest.mockResolvedValue(undefined);
    const onResolved = vi.fn();
    render(<ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={onResolved} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Delete request' }));
    expect(cancelApi.deleteChangeRequest).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Really delete request and branch?' }));
    await waitFor(() => expect(cancelApi.deleteChangeRequest).toHaveBeenCalledWith(12));
    await waitFor(() => expect(onResolved).toHaveBeenCalled());
  });

  it('no Delete request for non-admins', async () => {
    detailMock.fetchPrDetail.mockResolvedValue(detailWith([approval({})]));
    render(<ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />);
    await screen.findByText(/Waiting on approval/);
    expect(screen.queryByRole('button', { name: 'Delete request' })).not.toBeInTheDocument();
  });

  it("folds a long description to one line: Read more opens it, Hide folds it back", async () => {
    // Agents write essays. The decision is made on the diff — the quote gets
    // one row by default and only what the reader asks for beyond it.
    detailMock.fetchPrDetail.mockResolvedValue({
      ...detailWith([approval({ isApproved: true })]),
      body: 'A 6-slide reading deck…\n'.repeat(80),
    });
    render(<ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />);
    const quote = (await screen.findByText(/A 6-slide reading deck/)).closest('blockquote')!;
    expect(within(quote).getByText(/A 6-slide/).className).toContain('truncate');

    fireEvent.click(within(quote).getByRole('button', { name: 'Read more' }));
    expect(within(quote).getByText(/A 6-slide/).className).not.toContain('truncate');
    // Even expanded, an essay scrolls within itself rather than pushing the
    // file grid off screen.
    expect(quote.className).toContain('overflow-y-auto');

    fireEvent.click(within(quote).getByRole('button', { name: 'Hide' }));
    expect(within(quote).getByText(/A 6-slide/).className).toContain('truncate');
  });

  it('a short description is just the line — no pointless Read more', async () => {
    detailMock.fetchPrDetail.mockResolvedValue({
      ...detailWith([approval({ isApproved: true })]),
      body: 'Fixes a typo.',
    });
    render(<ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />);
    await screen.findByText('Fixes a typo.');
    expect(screen.queryByRole('button', { name: 'Read more' })).not.toBeInTheDocument();
  });

  it('offers no verbs to a viewer who cannot approve the file', async () => {
    detailMock.fetchPrDetail.mockResolvedValue(detailWith([approval({})]));
    render(<ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />);
    await screen.findByText(/Waiting on approval/);
    expect(screen.queryByRole('button', { name: 'Accept file' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Revert file' })).not.toBeInTheDocument();
  });
});
