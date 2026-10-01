import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { PullRequestSummary } from '@bevel-software/platform-shared';

/**
 * A surface that opens the dialog ABOUT one file — the explorer's proposed
 * row — hands it `initialPath`. The row is a link to the request's view of
 * THAT file: landing on the request's first file instead is landing somewhere
 * the reader did not click, and on a bundle of twenty proposals it is a
 * different document entirely.
 */

const detailMock = vi.hoisted(() => ({ fetchPrDetail: vi.fn() }));
vi.mock('../../pr/services/pr-detail.api', () => ({ fetchPrDetail: detailMock.fetchPrDetail }));

const branchApi = vi.hoisted(() => ({ readFileOnBranch: vi.fn(async () => 'branch copy') }));
vi.mock('../services/change-requests.api', () => ({
  readFileOnBranch: branchApi.readFileOnBranch,
}));
vi.mock('../../pr/services/pr-approvals.api', () => ({
  approvePrFile: vi.fn(),
  revertPrFile: vi.fn(),
  unapprovePrFile: vi.fn(),
}));
vi.mock('../../pr/services/pr-merge.api', () => ({ mergePullRequest: vi.fn(), refreshChangeRequestFromTarget: vi.fn() }));
vi.mock('../../pr/services/pr-cancel.api', () => ({
  cancelPullRequest: vi.fn(),
  deleteChangeRequest: vi.fn(),
}));

import { ChangeRequestDialog } from '../components/ChangeRequestDialog';

const CR = {
  number: 12,
  title: 'Changes from Ana. Knowledge',
  authorId: 'abc',
  author: { login: 'user-abc', name: 'Ana' },
  appAuthor: { name: 'Ana' },
  branch: 'suggestions/ana-1/knowledge',
  base: 'main',
  state: 'open',
  createdAt: '2026-08-07T00:00:00.000Z',
  touchedNodePaths: ['Knowledge/first.md', 'Sales/brief.md'],
  review: { approvals: 0, changesRequested: 0, pendingLogins: [] },
  url: '/change-requests/12',
} as unknown as PullRequestSummary;

/** Two files, in a fixed order, so "the first one" is unambiguous. */
const DETAIL = {
  ...CR,
  body: '',
  headSha: 'h',
  baseSha: 'b',
  files: ['Knowledge/first.md', 'Sales/brief.md'].map((path) => ({
    path,
    status: 'added' as const,
    additions: 1,
    deletions: 0,
    isBinary: false,
    sha: '',
    rawUrl: '',
  })),
  comments: [],
  approvals: [],
  mergeableInBevel: true,
  mergeBlockedReasons: [],
  mergeWarnings: [],
  viewerCanBypassMerge: false,
  viewerCanCancel: false,
};

/** The file the tree marks as selected. */
const selectedInTree = () =>
  screen
    .getAllByRole('treeitem')
    .find((row) => row.getAttribute('aria-selected') === 'true')
    ?.textContent;

beforeEach(() => {
  detailMock.fetchPrDetail.mockReset();
  branchApi.readFileOnBranch.mockClear();
  detailMock.fetchPrDetail.mockResolvedValue(DETAIL);
});

describe('ChangeRequestDialog: the file it opens at', () => {
  it('lands on the request first changed file when no caller names one', async () => {
    render(<ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />);
    expect(await screen.findByText(/Knowledge\/first\.md/)).toBeInTheDocument();
    await waitFor(() => expect(selectedInTree()).toContain('first.md'));
  });

  it('lands on the caller file — selected in the tree, named in the header, read for its diff', async () => {
    render(
      <ChangeRequestDialog
        cr={CR}
        initialPath="Sales/brief.md"
        onClose={() => {}}
        onResolved={() => {}}
      />,
    );
    // Named above the diff pane, and the pane is reading THAT file's copy off
    // the request's branch — not the first file's.
    expect(await screen.findByText(/Sales\/brief\.md/)).toBeInTheDocument();
    await waitFor(() => expect(selectedInTree()).toContain('brief.md'));
    expect(branchApi.readFileOnBranch).toHaveBeenCalledWith(CR.branch, 'Sales/brief.md');
    expect(branchApi.readFileOnBranch).not.toHaveBeenCalledWith(CR.branch, 'Knowledge/first.md');
  });

  it('falls back to the first file for a link the request no longer contains', async () => {
    // A `?cr=&file=` link outlives the request it was copied from: the file
    // is renamed, or reverted out of it, or the link is simply old. The seed
    // holds while the detail is in flight — that is the landing it exists
    // for — and the detail is what ends it: a file the request does not
    // contain leaves the pane reporting that file unreadable, which is the
    // request not opening at all as far as the reader can tell.
    render(
      <ChangeRequestDialog
        cr={CR}
        initialPath="Sales/gone.md"
        onClose={() => {}}
        onResolved={() => {}}
      />,
    );
    await waitFor(() => expect(selectedInTree()).toContain('first.md'));
    expect(await screen.findByText(/Knowledge\/first\.md/)).toBeInTheDocument();
    expect(branchApi.readFileOnBranch).toHaveBeenCalledWith(CR.branch, 'Knowledge/first.md');
  });

  it('seeds the selection rather than pinning it — the reader can still click away', async () => {
    render(
      <ChangeRequestDialog
        cr={CR}
        initialPath="Sales/brief.md"
        onClose={() => {}}
        onResolved={() => {}}
      />,
    );
    await waitFor(() => expect(selectedInTree()).toContain('brief.md'));
    (await screen.findByRole('button', { name: 'first.md' })).click();
    await waitFor(() => expect(selectedInTree()).toContain('first.md'));
  });
});
