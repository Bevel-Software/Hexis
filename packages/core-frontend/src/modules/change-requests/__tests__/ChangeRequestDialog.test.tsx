import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { PullRequestSummary } from '@bevel-software/platform-shared';

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
  readFileOnBranch: vi.fn(async () => ''),
}));
vi.mock('../../pr/services/pr-approvals.api', () => ({ approvePrFile: vi.fn() }));
vi.mock('../../pr/services/pr-merge.api', () => ({ mergePullRequest: vi.fn() }));

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
