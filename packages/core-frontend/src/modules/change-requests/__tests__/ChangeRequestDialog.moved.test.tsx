import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { PrFileStatus, PullRequestSummary } from '@bevel-software/platform-shared';

/**
 * A MOVED file in the change-request view.
 *
 * The pane reads the selected path on both branches. For a rename the
 * selection is the NEW path — a path the default branch has never had — so
 * that read 404s, and the pane, which had no way to tell a failed read from a
 * slow one, sat on "Loading…" for as long as anyone cared to watch. The
 * before-side of a move is the file at `previousPath`; these tests pin the
 * three readings that follow from it (rename with edits, pure move, no
 * readable old path), plus the general failed-read state and the unchanged
 * behaviour for an ordinary modified file.
 */

const detailMock = vi.hoisted(() => ({ fetchPrDetail: vi.fn() }));
vi.mock('../../pr/services/pr-detail.api', () => ({ fetchPrDetail: detailMock.fetchPrDetail }));

const readMock = vi.hoisted(() => ({ readFileOnBranch: vi.fn() }));
vi.mock('../services/change-requests.api', () => ({
  readFileOnBranch: readMock.readFileOnBranch,
}));
vi.mock('../../pr/services/pr-approvals.api', () => ({
  approvePrFile: vi.fn(),
  revertPrFile: vi.fn(),
  unapprovePrFile: vi.fn(),
}));
vi.mock('../../pr/services/pr-merge.api', () => ({ mergePullRequest: vi.fn() }));
vi.mock('../../pr/services/pr-cancel.api', () => ({
  cancelPullRequest: vi.fn(),
  deleteChangeRequest: vi.fn(),
}));

import { ChangeRequestDialog } from '../components/ChangeRequestDialog';

/** What `test-setup.ts` pins the default branch to. */
const MAIN = 'target-company-state';
const CR_BRANCH = 'ali.raza/move-the-runbook';

const OLD_PATH = 'Ops/runbook.yaml';
const NEW_PATH = 'Docs/Ops/runbook.yaml';

const CR: PullRequestSummary = {
  number: 12,
  title: 'Move the runbook under Docs',
  authorId: 'abc',
  author: { login: 'user-abc', name: 'Ali' },
  appAuthor: { name: 'Ali' },
  branch: CR_BRANCH,
  base: 'main',
  state: 'open',
  createdAt: '2026-08-07T00:00:00.000Z',
  touchedNodePaths: [],
  review: { approvals: 0, changesRequested: 0, pendingLogins: [] },
  url: '/change-requests/12',
} as unknown as PullRequestSummary;

function detailWith(file: {
  path: string;
  status: PrFileStatus;
  previousPath?: string;
}) {
  return {
    ...CR,
    body: '',
    headSha: 'h',
    baseSha: 'b',
    files: [{ ...file, additions: 1, deletions: 1, isBinary: false, sha: '', rawUrl: '' }],
    comments: [],
    approvals: [],
    mergeableInBevel: true,
    mergeBlockedReasons: [],
    mergeWarnings: [],
    viewerCanBypassMerge: false,
    viewerCanCancel: false,
  };
}

/** Reads answered per (branch, path); anything unlisted rejects, as the API does. */
function reads(answers: Record<string, string>) {
  readMock.readFileOnBranch.mockImplementation(async (branch: string, path: string) => {
    const key = `${branch}::${path}`;
    if (!(key in answers)) throw new Error(`404 ${key}`);
    return answers[key];
  });
}

const marks = () => ({
  removed: [...document.querySelectorAll('del')].map((n) => n.textContent),
  added: [...document.querySelectorAll('ins')].map((n) => n.textContent),
});

beforeEach(() => {
  detailMock.fetchPrDetail.mockReset();
  readMock.readFileOnBranch.mockReset();
});

describe('ChangeRequestDialog: a moved file', () => {
  it('diffs the OLD path on the default branch against the new one, and names the move', async () => {
    detailMock.fetchPrDetail.mockResolvedValue(
      detailWith({ path: NEW_PATH, status: 'renamed', previousPath: OLD_PATH }),
    );
    reads({
      [`${MAIN}::${OLD_PATH}`]: 'steps:\n  - stop the writer\n',
      [`${CR_BRANCH}::${NEW_PATH}`]: 'steps:\n  - stop the writer, then drain\n',
    });

    render(<ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />);

    expect(await screen.findByText(`Moved: ${OLD_PATH} → ${NEW_PATH}`)).toBeInTheDocument();
    // The standard marked-up reading: the edit, not the move, is what is marked.
    await screen.findByText('- stop the writer, then drain', { exact: false });
    expect(marks().removed).toEqual(['  - stop the writer']);
    expect(marks().added).toEqual(['  - stop the writer, then drain']);
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
    // Never the new path on the default branch — that read is the 404 that hung.
    expect(readMock.readFileOnBranch).not.toHaveBeenCalledWith(MAIN, NEW_PATH);
  });

  it('a pure move shows the move note and the content, with nothing marked', async () => {
    const body = 'steps:\n  - stop the writer\n';
    detailMock.fetchPrDetail.mockResolvedValue(
      detailWith({ path: NEW_PATH, status: 'renamed', previousPath: OLD_PATH }),
    );
    reads({ [`${MAIN}::${OLD_PATH}`]: body, [`${CR_BRANCH}::${NEW_PATH}`]: body });

    render(<ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />);

    expect(await screen.findByText(`Moved: ${OLD_PATH} → ${NEW_PATH}`)).toBeInTheDocument();
    await screen.findByText('- stop the writer', { exact: false });
    expect(marks()).toEqual({ removed: [], added: [] });
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
  });

  it('an unreadable old path says so and shows the NEW content, unmarked', async () => {
    detailMock.fetchPrDetail.mockResolvedValue(
      detailWith({ path: NEW_PATH, status: 'renamed', previousPath: OLD_PATH }),
    );
    // The old path is gone from the default branch too (or unreadable there).
    reads({ [`${CR_BRANCH}::${NEW_PATH}`]: 'steps:\n  - stop the writer\n' });

    render(<ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />);

    expect(await screen.findByText(/old path couldn't be read/)).toBeInTheDocument();
    // Review proceeds on what the request actually proposes.
    await screen.findByText('- stop the writer', { exact: false });
    expect(marks()).toEqual({ removed: [], added: [] });
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
  });

  it('a rename with no previousPath at all lands in the same fallback', async () => {
    detailMock.fetchPrDetail.mockResolvedValue({
      ...detailWith({ path: NEW_PATH, status: 'renamed' }),
    });
    reads({
      [`${MAIN}::${NEW_PATH}`]: 'never asked for',
      [`${CR_BRANCH}::${NEW_PATH}`]: 'steps:\n  - stop the writer\n',
    });

    render(<ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />);

    expect(await screen.findByText(/old path couldn't be read/)).toBeInTheDocument();
    await screen.findByText('- stop the writer', { exact: false });
    // With no old path there is nothing to name, so no move line is claimed.
    expect(screen.queryByText(/^Moved:/)).not.toBeInTheDocument();
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
  });
});

describe('ChangeRequestDialog: a default-branch read that fails', () => {
  it("resolves to the pane's couldn't-be-read state rather than an endless Loading", async () => {
    detailMock.fetchPrDetail.mockResolvedValue(
      detailWith({ path: NEW_PATH, status: 'modified' }),
    );
    reads({ [`${CR_BRANCH}::${NEW_PATH}`]: 'steps:\n  - stop the writer\n' });

    render(<ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />);

    expect(await screen.findByText(/couldn't be read/)).toBeInTheDocument();
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
  });

  it('an ordinary modified file still reads exactly as it did', async () => {
    detailMock.fetchPrDetail.mockResolvedValue(
      detailWith({ path: NEW_PATH, status: 'modified' }),
    );
    reads({
      [`${MAIN}::${NEW_PATH}`]: 'steps:\n  - stop the writer\n',
      [`${CR_BRANCH}::${NEW_PATH}`]: 'steps:\n  - stop the writer, then drain\n',
    });

    render(<ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />);

    await screen.findByText('- stop the writer, then drain', { exact: false });
    expect(marks().removed).toEqual(['  - stop the writer']);
    expect(marks().added).toEqual(['  - stop the writer, then drain']);
    expect(screen.queryByText(/^Moved:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/couldn't be read/)).not.toBeInTheDocument();
  });
});
