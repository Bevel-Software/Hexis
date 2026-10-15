import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { PullRequestSummary } from '@bevel-software/platform-shared';

/**
 * Editing a request's title and description from its dialog: offered to the
 * people the server says may (`viewerCanEdit` — the author, or anyone who may
 * merge it), saved through the PATCH route, and shown at once — in the dialog
 * from a fresh read, and in every list through the stale signal.
 */

const detailMock = vi.hoisted(() => ({ fetchPrDetail: vi.fn() }));
vi.mock('../../pr/services/pr-detail.api', () => ({ fetchPrDetail: detailMock.fetchPrDetail }));
vi.mock('../services/change-requests.api', () => ({
  readFileOnBranch: vi.fn(async () => 'branch copy'),
}));
vi.mock('../../pr/services/pr-approvals.api', () => ({
  approvePrFile: vi.fn(),
  revertPrFile: vi.fn(),
  unapprovePrFile: vi.fn(),
}));
vi.mock('../../pr/services/pr-merge.api', () => ({
  mergePullRequest: vi.fn(),
  refreshChangeRequestFromTarget: vi.fn(),
}));
vi.mock('../../pr/services/pr-cancel.api', () => ({
  cancelPullRequest: vi.fn(),
  deleteChangeRequest: vi.fn(),
}));
const editApi = vi.hoisted(() => ({ updateChangeRequest: vi.fn() }));
vi.mock('../../pr/services/pr-edit.api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../pr/services/pr-edit.api')>()),
  updateChangeRequest: editApi.updateChangeRequest,
}));

import { ChangeRequestDialog } from '../components/ChangeRequestDialog';
import { PR_STALE_EVENT } from '../../../core/events';
import { GitApiError } from '../../git/services/git.api';

const GENERATED = '## Affected owners\n\n- `Docs/a.md` — Admin';

const CR: PullRequestSummary = {
  number: 12,
  title: 'Old title',
  authorId: 'abc',
  author: { login: 'user-abc', name: 'Ali' },
  appAuthor: { name: 'Ali' },
  branch: 'ali.raza/draft',
  base: 'main',
  state: 'open',
  createdAt: '2026-08-07T00:00:00.000Z',
  touchedNodePaths: [],
  review: { approvals: 0, changesRequested: 0, pendingLogins: [] },
  url: '/change-requests/12',
} as unknown as PullRequestSummary;

function detail(over: Record<string, unknown> = {}) {
  return {
    ...CR,
    body: `Old reason.\n\n## My own section\n\nDetails.\n\n${GENERATED}`,
    headSha: 'h',
    baseSha: 'b',
    files: [],
    approvals: [],
    mergeableInBevel: false,
    mergeBlockedReasons: [],
    mergeWarnings: [],
    viewerCanBypassMerge: false,
    viewerCanCancel: true,
    viewerCanDelete: false,
    viewerCanEdit: true,
    ...over,
  };
}

beforeEach(() => {
  detailMock.fetchPrDetail.mockReset();
  editApi.updateChangeRequest.mockReset();
});

describe('ChangeRequestDialog: editing the title and description', () => {
  it('offers no Edit control to someone who may not edit', async () => {
    detailMock.fetchPrDetail.mockResolvedValue(detail({ viewerCanEdit: false }));
    render(<ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />);
    expect(await screen.findByText('Old reason.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  });

  it("offers the author's whole text — own headings included, generated block left out", async () => {
    detailMock.fetchPrDetail.mockResolvedValue(detail());
    render(<ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('Old title');
    expect(screen.getByRole('textbox', { name: 'Description' })).toHaveValue(
      'Old reason.\n\n## My own section\n\nDetails.',
    );
  });

  it('saves only what changed, then shows the new text and refreshes every list', async () => {
    detailMock.fetchPrDetail.mockResolvedValueOnce(detail());
    editApi.updateChangeRequest.mockResolvedValue({ ...CR, title: 'New title' });
    detailMock.fetchPrDetail.mockResolvedValueOnce(
      detail({
        title: 'New title',
        body: `P2 - Planned\n\nNew reason.\n\n${GENERATED}`,
      }),
    );
    const stale = vi.fn();
    window.addEventListener(PR_STALE_EVENT, stale);
    render(<ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Description' }), {
      target: { value: 'P2 - Planned\n\nNew reason.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(editApi.updateChangeRequest).toHaveBeenCalledWith(12, { description: 'P2 - Planned\n\nNew reason.' }),
    );
    expect(await screen.findByRole('heading', { name: 'New title' })).toBeInTheDocument();
    expect(screen.getByText(/New reason\./)).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Description' })).not.toBeInTheDocument();
    expect(detailMock.fetchPrDetail).toHaveBeenLastCalledWith(12, { fresh: true });
    expect(stale).toHaveBeenCalled();
    window.removeEventListener(PR_STALE_EVENT, stale);
  });

  it("shows the server's refusal in its words and keeps the draft", async () => {
    detailMock.fetchPrDetail.mockResolvedValue(detail());
    editApi.updateChangeRequest.mockRejectedValue(
      new GitApiError(409, 'This change request has already been applied; its title and description can no longer be changed.', {}),
    );
    render(<ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'Newer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('already been applied');
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('Newer');
  });

  it('will not save an empty title', async () => {
    detailMock.fetchPrDetail.mockResolvedValue(detail());
    render(<ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: '  ' } });
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });
});
