import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PullRequestSummary } from '@bevel-software/platform-shared';

/**
 * A file in a change request the viewer may not read.
 *
 * The dialog used to keep one `unreadable` flag per file and render one
 * sentence for every failure — "…couldn't be read, so there is no honest
 * before and after to show." A tester who was simply not allowed to see the
 * file read that as an outage and asked what had broken. Nothing had: the
 * answer was that the file was not theirs.
 *
 * So there are two forms now. A refusal names the access decision and the
 * folder to ask an owner of; anything else names the reason and offers a
 * retry. Both drop the word "honest", and the list carries a lock beside a
 * file the viewer was refused.
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

/**
 * The two calls that NAME the folder are stubbed, the classifier that uses
 * them is not: the point of these tests is that a 403 travels from the read
 * all the way to the sentence, folder and all.
 */
const wsMock = vi.hoisted(() => ({ getOrCreateWorkspace: vi.fn() }));
vi.mock('../../workspace/services/workspace.api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../workspace/services/workspace.api')>()),
  getOrCreateWorkspace: wsMock.getOrCreateWorkspace,
}));
const accessMock = vi.hoisted(() => ({ fetchFileAccess: vi.fn() }));
vi.mock('../../access/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../access/api')>()),
  fetchFileAccess: accessMock.fetchFileAccess,
}));

import { ChangeRequestDialog } from '../components/ChangeRequestDialog';
import { WorkspaceApiError } from '../../workspace/services/workspace.api';

/** What `test-setup.ts` pins the default branch to. */
const MAIN = 'target-company-state';
const CR_BRANCH = 'ali.raza/payroll-bands';
const PATH = 'Knowledge/Finance/Payroll/bands.yaml';

const DENIED_HERE =
  "You don't have access to read this file, so its content can't be shown here. " +
  'Ask an owner of Knowledge/Finance/Payroll for read access if you need to review it.';
const DENIED_UNNAMED =
  "You don't have access to read this file, so its content can't be shown here. " +
  'Ask an owner of this file for read access if you need to review it.';

const CR: PullRequestSummary = {
  number: 31,
  title: 'Refresh the payroll bands',
  authorId: 'abc',
  author: { login: 'user-abc', name: 'Ali' },
  appAuthor: { name: 'Ali' },
  branch: CR_BRANCH,
  base: 'main',
  state: 'open',
  createdAt: '2026-09-17T00:00:00.000Z',
  touchedNodePaths: [],
  review: { approvals: 0, changesRequested: 0, pendingLogins: [] },
  url: '/change-requests/31',
} as unknown as PullRequestSummary;

const detail = {
  ...CR,
  body: '',
  headSha: 'h',
  baseSha: 'b',
  files: [
    {
      path: PATH,
      status: 'modified' as const,
      additions: 1,
      deletions: 1,
      isBinary: false,
      sha: '',
      rawUrl: '',
    },
  ],
  comments: [],
  approvals: [],
  mergeableInBevel: true,
  mergeBlockedReasons: [],
  mergeWarnings: [],
  viewerCanBypassMerge: false,
  viewerCanCancel: false,
};

/** The read answers per branch: a string resolves, an error rejects. */
function reads(answers: Record<string, string | Error>) {
  readMock.readFileOnBranch.mockImplementation(async (branch: string) => {
    const answer = answers[branch];
    if (answer === undefined) throw new WorkspaceApiError(404);
    if (answer instanceof Error) throw answer;
    return answer;
  });
}

/** The resolved access view, as far as the folder-naming cares about it. */
function governedBy(accessMdPath: string) {
  accessMock.fetchFileAccess.mockResolvedValue({
    sources: { 'r:admin': { owner: [{ kind: 'ancestor', path: accessMdPath }] } },
  });
}

beforeEach(() => {
  detailMock.fetchPrDetail.mockReset();
  readMock.readFileOnBranch.mockReset();
  accessMock.fetchFileAccess.mockReset();
  wsMock.getOrCreateWorkspace.mockReset();
  wsMock.getOrCreateWorkspace.mockResolvedValue({
    workspace: { id: 'ws-1', kbDirName: 'knowledge-base' },
    fileTree: null,
  });
  detailMock.fetchPrDetail.mockResolvedValue(detail);
});

describe("ChangeRequestDialog: a file the viewer may not read", () => {
  it('says it is an access decision, and names the folder to ask an owner of', async () => {
    reads({ [CR_BRANCH]: new WorkspaceApiError(403), [MAIN]: 'bands:\n  - L3\n' });
    governedBy('Knowledge/Finance/Payroll/access.md');

    render(<ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />);

    expect(await screen.findByText(DENIED_HERE)).toBeInTheDocument();
    // The old sentence, and the word the ticket was filed about, are gone.
    expect(screen.queryByText(/no honest before and after/)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/honest/);
    // Nothing to retry: another read gets the same refusal.
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    // The folder was resolved against the change request's own branch.
    expect(wsMock.getOrCreateWorkspace).toHaveBeenCalledWith(CR_BRANCH);
    expect(accessMock.fetchFileAccess).toHaveBeenCalledWith('ws-1', PATH);
  });

  it('carries a lock on the file row, with the same sentence as its tooltip', async () => {
    reads({ [CR_BRANCH]: new WorkspaceApiError(403), [MAIN]: 'bands:\n  - L3\n' });
    governedBy('Knowledge/Finance/Payroll/access.md');

    render(<ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />);
    await screen.findByText(DENIED_HERE);

    const tree = screen.getByRole('tree', { name: 'Files in this change request' });
    const lock = within(tree).getByRole('img', { name: DENIED_HERE });
    expect(lock).toHaveAttribute('title', DENIED_HERE);
  });

  it('falls back to "this file" when no folder can be named', async () => {
    reads({ [CR_BRANCH]: new WorkspaceApiError(403), [MAIN]: 'bands:\n  - L3\n' });
    // The rule lives in the file's own frontmatter — there is no folder whose
    // owners to point at, and the platform does not invent one.
    accessMock.fetchFileAccess.mockResolvedValue({
      sources: { 'u:ali@example.com': { read: [{ kind: 'direct' }] } },
    });

    render(<ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />);

    expect(await screen.findByText(DENIED_UNNAMED)).toBeInTheDocument();
  });

  it('still says it plainly when the folder lookup itself fails', async () => {
    reads({ [CR_BRANCH]: new WorkspaceApiError(403), [MAIN]: 'bands:\n  - L3\n' });
    accessMock.fetchFileAccess.mockRejectedValue(new WorkspaceApiError(503));

    render(<ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />);

    expect(await screen.findByText(DENIED_UNNAMED)).toBeInTheDocument();
  });

  it('gives the CURRENT text the same two forms — a refused base copy reads the same', async () => {
    reads({ [CR_BRANCH]: 'bands:\n  - L3\n', [MAIN]: new WorkspaceApiError(403) });
    governedBy('Knowledge/Finance/Payroll/access.md');

    render(<ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />);

    expect(await screen.findByText(DENIED_HERE)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/honest/);
    expect(wsMock.getOrCreateWorkspace).toHaveBeenCalledWith(MAIN);
  });
});

describe('ChangeRequestDialog: a read that merely broke', () => {
  it("names the reason and offers a retry — not an access sentence", async () => {
    reads({ [CR_BRANCH]: new WorkspaceApiError(500), [MAIN]: 'bands:\n  - L3\n' });

    render(<ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />);

    const note = await screen.findByText(/couldn't be read right now/);
    expect(note).toHaveTextContent("This file couldn't be read right now (HTTP 500). Try again.");
    expect(note.textContent).not.toMatch(/honest/);
    expect(screen.queryByText(/don't have access/)).not.toBeInTheDocument();
    // A broken read is not a refusal, so the row carries no lock.
    const tree = screen.getByRole('tree', { name: 'Files in this change request' });
    expect(within(tree).queryByRole('img', { name: /don't have access/ })).not.toBeInTheDocument();
    // Nothing to ask an owner about, so nothing was looked up.
    expect(accessMock.fetchFileAccess).not.toHaveBeenCalled();
  });

  it('re-fetches that file when the retry is taken, and shows it once it lands', async () => {
    let branchAttempts = 0;
    readMock.readFileOnBranch.mockImplementation(async (branch: string) => {
      if (branch !== CR_BRANCH) return 'bands:\n  - L3\n';
      branchAttempts += 1;
      if (branchAttempts === 1) throw new WorkspaceApiError(500);
      return 'bands:\n  - L4\n';
    });

    render(<ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />);
    await screen.findByText(/couldn't be read right now/);

    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));

    await waitFor(() => expect(branchAttempts).toBe(2));
    // The second read landed, so the pane shows the change instead of the note.
    await waitFor(() =>
      expect([...document.querySelectorAll('ins')].map((n) => n.textContent)).toEqual(['  - L4']),
    );
    expect(screen.queryByText(/couldn't be read right now/)).not.toBeInTheDocument();
  });
});
