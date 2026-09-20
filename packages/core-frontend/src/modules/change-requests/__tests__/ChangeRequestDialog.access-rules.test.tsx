import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { PullRequestSummary } from '@bevel-software/platform-shared';

/**
 * The access rules file in the change-request view.
 *
 * `access.md` is YAML with `#` explanations. The file page shows it as text
 * (`getFileRenderer` maps the name to `TextRenderer`), but the dialog picked
 * its diff by extension alone, so a join request's rules change rendered as a
 * Markdown document: every comment line a heading, the rules between them
 * lost. The dialog now asks the renderer registry, and the file reads as the
 * marked-source text it is on both sides. An ordinary `.md` is unchanged.
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
const CR_BRANCH = 'ali.raza/join-engineering';

const CR: PullRequestSummary = {
  number: 21,
  title: 'Ali asks to join Engineering',
  authorId: 'abc',
  author: { login: 'user-abc', name: 'Ali' },
  appAuthor: { name: 'Ali' },
  branch: CR_BRANCH,
  base: 'main',
  state: 'open',
  createdAt: '2026-09-17T00:00:00.000Z',
  touchedNodePaths: [],
  review: { approvals: 0, changesRequested: 0, pendingLogins: [] },
  url: '/change-requests/21',
} as unknown as PullRequestSummary;

function detailWith(path: string) {
  return {
    ...CR,
    body: '',
    headSha: 'h',
    baseSha: 'b',
    files: [
      { path, status: 'modified', additions: 1, deletions: 0, isBinary: false, sha: '', rawUrl: '' },
    ],
    comments: [],
    approvals: [],
    mergeableInBevel: true,
    mergeBlockedReasons: [],
    mergeWarnings: [],
    viewerCanBypassMerge: false,
    viewerCanCancel: false,
  };
}

function reads(answers: Record<string, string>) {
  readMock.readFileOnBranch.mockImplementation(async (branch: string, path: string) => {
    const key = `${branch}::${path}`;
    if (!(key in answers)) throw new Error(`404 ${key}`);
    return answers[key];
  });
}

const CURRENT = [
  '# Who may read and change what.',
  '# One group per block.',
  'groups:',
  '  engineering:',
  '    members:',
  '      - sara',
  '',
].join('\n');
const PROPOSED = CURRENT.replace('      - sara\n', '      - sara\n      - ali\n');

beforeEach(() => {
  detailMock.fetchPrDetail.mockReset();
  readMock.readFileOnBranch.mockReset();
});

describe('ChangeRequestDialog: the access rules file', () => {
  it('shows access.md as a marked text diff, not a Markdown document', async () => {
    detailMock.fetchPrDetail.mockResolvedValue(detailWith('access.md'));
    reads({ [`${MAIN}::access.md`]: CURRENT, [`${CR_BRANCH}::access.md`]: PROPOSED });

    render(<ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />);

    const comment = await screen.findByText('# Who may read and change what.');
    // A line of the monospaced block, in its normal size — not a heading.
    expect(comment.closest('pre')).not.toBeNull();
    expect(screen.queryByRole('heading', { name: /group/i })).toBeNull();
    // Both sides are in the one block: the unchanged lines, and the change marked.
    expect(screen.getByText('groups:')).toBeInTheDocument();
    expect([...document.querySelectorAll('ins')].map((n) => n.textContent)).toEqual([
      '      - ali',
    ]);
    expect(document.querySelectorAll('del')).toHaveLength(0);
    // Read from both branches — the current side as well as the proposed one.
    expect(readMock.readFileOnBranch).toHaveBeenCalledWith(MAIN, 'access.md');
    expect(readMock.readFileOnBranch).toHaveBeenCalledWith(CR_BRANCH, 'access.md');
  });

  it('matches the name in any folder, whatever its case', async () => {
    const path = 'Teams/Engineering/Access.md';
    detailMock.fetchPrDetail.mockResolvedValue(detailWith(path));
    reads({ [`${MAIN}::${path}`]: CURRENT, [`${CR_BRANCH}::${path}`]: PROPOSED });

    render(<ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />);

    const comment = await screen.findByText('# One group per block.');
    expect(comment.closest('pre')).not.toBeNull();
    expect(screen.queryByRole('heading', { name: /group/i })).toBeNull();
  });

  it('still renders an ordinary .md as a document', async () => {
    const path = 'Knowledge/onboarding.md';
    detailMock.fetchPrDetail.mockResolvedValue(detailWith(path));
    reads({
      [`${MAIN}::${path}`]: '# Onboarding\n\nRead the handbook.\n',
      [`${CR_BRANCH}::${path}`]: '# Onboarding\n\nRead the handbook first.\n',
    });

    render(<ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />);

    expect(await screen.findByRole('heading', { name: 'Onboarding' })).toBeInTheDocument();
  });
});
