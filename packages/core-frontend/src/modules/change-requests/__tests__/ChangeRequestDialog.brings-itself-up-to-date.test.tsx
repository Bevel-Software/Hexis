import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { FileApprovalState, PullRequestSummary } from '@bevel-software/platform-shared';

/**
 * A change request whose target has moved on brings ITSELF up to date when
 * the person opening it is allowed to — no button, no confirmation — and says
 * so in words a business user reads. Razvan's point on core-staging: nobody
 * outside engineering knows what `main` is, and nobody should have to press a
 * button to get a proposal that merges cleanly back into shape.
 *
 * What these pin: the automatic update for the three viewers who may run it,
 * silence for the one who may not, the conflict path, once-per-open, and the
 * guard that no state of this dialog ever prints the default branch name.
 */

const detailMock = vi.hoisted(() => ({ fetchPrDetail: vi.fn() }));
vi.mock('../../pr/services/pr-detail.api', () => ({ fetchPrDetail: detailMock.fetchPrDetail }));

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

/**
 * The default branch's git name, as the deployment sets it. No rendered
 * sentence in this dialog may contain it — that is the whole point of the
 * ticket, and `GUARD` below is what holds it.
 */
const TARGET = 'main';
const FORK = 'f'.repeat(40);
const BEFORE = 'price: 100\n';
const PROPOSED = 'price: 120\n';

const CR = {
  number: 105,
  title: 'Deal pricing',
  authorId: 'abc',
  author: { login: 'alice', name: 'Alice Doe' },
  appAuthor: { name: 'Alice Doe' },
  branch: 'alice/deal-pricing',
  base: TARGET,
  state: 'open',
  createdAt: '2026-09-16T00:00:00.000Z',
  touchedNodePaths: ['Sales/deal.yaml'],
  review: { approvals: 0, changesRequested: 0, pendingLogins: [] },
  url: '/change-requests/105',
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

const RUNNING = 'Bringing this up to date with what everyone sees…';
const DONE = 'Brought up to date with what everyone sees.';
const READER_NOTICE =
  'What everyone sees has changed since this was proposed. Its author, or someone who can apply it, brings it up to date by opening it.';

const conflict = () =>
  new GitApiError(409, `Conflicts merging "${TARGET}" into "alice/deal-pricing".`, {
    kind: 'change-request-conflicts',
    conflictedPaths: ['Sales/deal.yaml'],
    error: 'Conflicts',
  });

beforeEach(() => {
  detailMock.fetchPrDetail.mockReset();
  mergeApi.refreshChangeRequestFromTarget.mockReset().mockResolvedValue({});
  filesApi.readFileAtForkPoint
    .mockReset()
    .mockImplementation(async (_n: number, sha: string) => ({ content: BEFORE, forkSha: sha }));
  filesApi.readFileOnBranch.mockReset().mockResolvedValue(PROPOSED);
});

/**
 * The three viewers the route lets update a request. The dialog reads one
 * flag (`viewerCanUpdate`) for all three — which of them the caller IS is
 * decided by `computeViewerCanUpdate` on the server and pinned there — so
 * each case here carries the detail that predicate would have answered `true`
 * for, and asserts the dialog acts on it.
 */
const MAY_UPDATE: [string, Record<string, unknown>][] = [
  ['its author', { viewerCanUpdate: true, viewerCanCancel: true }],
  ['an admin', { viewerCanUpdate: true, viewerCanBypassMerge: true }],
  [
    'someone who may apply it',
    {
      viewerCanUpdate: true,
      approvals: [{ ...approval, inMergeGate: true, viewerCanApprove: true }],
    },
  ],
];

describe('ChangeRequestDialog: a stale request brings itself up to date', () => {
  it.each(MAY_UPDATE)('updates itself on open for %s — no button, no confirmation', async (_who, over) => {
    detailMock.fetchPrDetail
      .mockResolvedValueOnce(detail(over))
      .mockResolvedValue(detail({ ...over, behind: false }));

    const { container } = render(
      <ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />,
    );

    await waitFor(() => expect(mergeApi.refreshChangeRequestFromTarget).toHaveBeenCalledWith(105));
    expect(await screen.findByText(DONE)).toBeInTheDocument();
    // Nothing was pressed to get here, and there is nothing left to press.
    expect(screen.queryByRole('button', { name: 'Update' })).not.toBeInTheDocument();
    expect(screen.queryByText(RUNNING)).not.toBeInTheDocument();
    // The fresh files are what is on screen — the proposal, not an error.
    await waitFor(() => expect(container.querySelector('ins')?.textContent).toBe('price: 120'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows the status line and NO file content while the update runs', async () => {
    let land: (v: unknown) => void = () => {};
    mergeApi.refreshChangeRequestFromTarget.mockImplementation(
      () => new Promise((resolve) => (land = resolve)),
    );
    detailMock.fetchPrDetail
      .mockResolvedValueOnce(detail())
      .mockResolvedValue(detail({ behind: false }));

    const { container } = render(
      <ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />,
    );

    expect(await screen.findByText(RUNNING)).toBeInTheDocument();
    // Not the pre-update text, and not a diff of it: the proposal on screen
    // must never be the one against text that has already moved.
    expect(container.textContent).not.toContain('price: 120');
    expect(container.querySelector('ins')).toBeNull();
    expect(filesApi.readFileOnBranch).not.toHaveBeenCalled();
    expect(filesApi.readFileAtForkPoint).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Apply changes' })).not.toBeInTheDocument();

    land({});
    expect(await screen.findByText(DONE)).toBeInTheDocument();
    expect(screen.queryByText(RUNNING)).not.toBeInTheDocument();
    await waitFor(() => expect(container.querySelector('ins')?.textContent).toBe('price: 120'));
  });

  it('never runs for a viewer who may not update it — they get the plain-words notice, no button', async () => {
    detailMock.fetchPrDetail.mockResolvedValue(detail({ viewerCanUpdate: false }));
    render(<ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />);

    expect(await screen.findByText(READER_NOTICE)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Update' })).not.toBeInTheDocument();
    expect(screen.queryByText(RUNNING)).not.toBeInTheDocument();
    expect(mergeApi.refreshChangeRequestFromTarget).not.toHaveBeenCalled();
    // They still read the request as proposed.
    await waitFor(() => expect(screen.getByText(/1 file/)).toBeInTheDocument());
  });

  it('never runs on a request that is no longer open', async () => {
    detailMock.fetchPrDetail.mockResolvedValue(detail({ state: 'merged', behind: true }));
    render(<ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />);

    await waitFor(() => expect(screen.getByText(/1 file/)).toBeInTheDocument());
    expect(mergeApi.refreshChangeRequestFromTarget).not.toHaveBeenCalled();
    expect(screen.queryByText(RUNNING)).not.toBeInTheDocument();
    expect(screen.queryByText(READER_NOTICE)).not.toBeInTheDocument();
  });

  it('says nothing at all about updating when the request is already up to date', async () => {
    detailMock.fetchPrDetail.mockResolvedValue(detail({ behind: false }));
    render(<ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />);

    await waitFor(() => expect(screen.getByText(/1 file/)).toBeInTheDocument());
    expect(mergeApi.refreshChangeRequestFromTarget).not.toHaveBeenCalled();
    expect(screen.queryByText(DONE)).not.toBeInTheDocument();
    expect(screen.queryByText(RUNNING)).not.toBeInTheDocument();
    expect(screen.queryByText(READER_NOTICE)).not.toBeInTheDocument();
  });

  it('runs at most once per open, however many times the detail changes under it', async () => {
    // The re-read after the merge still reports `behind` — a second change
    // landed on the target while this one was merging. The dialog must not
    // chase it: one update per open, and the next open picks up the rest.
    detailMock.fetchPrDetail.mockResolvedValue(detail());
    render(<ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />);

    await waitFor(() => expect(mergeApi.refreshChangeRequestFromTarget).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText(DONE)).toBeInTheDocument());
    await new Promise((r) => setTimeout(r, 30));
    expect(mergeApi.refreshChangeRequestFromTarget).toHaveBeenCalledTimes(1);
  });

  it('two people opening the same stale request at once: the second finds nothing to merge, and neither sees an error', async () => {
    // The server answers an already-merged update with a plain, successful
    // detail — nothing merged, nothing to report.
    detailMock.fetchPrDetail
      .mockResolvedValueOnce(detail())
      .mockResolvedValue(detail({ behind: false }));
    render(<ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />);

    expect(await screen.findByText(DONE)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('ChangeRequestDialog: an update that cannot be combined', () => {
  it('says so in plain words, keeps the conflict help, and offers no button', async () => {
    mergeApi.refreshChangeRequestFromTarget.mockRejectedValue(conflict());
    detailMock.fetchPrDetail.mockResolvedValue(detail());
    render(<ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />);

    const banner = await screen.findByRole('alert');
    expect(banner.textContent).toContain(
      "what everyone sees has changed since this was proposed, and the two can't be combined automatically",
    );
    // NOT the apply refusal: nobody tried to apply anything.
    expect(banner.textContent).not.toContain("Can't apply");
    expect(screen.getByText(/Fastest fix: ask your agent to resolve it/)).toBeInTheDocument();
    expect(screen.getByText(/Change request #105 can no longer be applied/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Update' })).not.toBeInTheDocument();
  });

  it('is not retried on that open', async () => {
    mergeApi.refreshChangeRequestFromTarget.mockRejectedValue(conflict());
    detailMock.fetchPrDetail.mockResolvedValue(detail());
    render(<ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />);

    await screen.findByRole('alert');
    await new Promise((r) => setTimeout(r, 30));
    expect(mergeApi.refreshChangeRequestFromTarget).toHaveBeenCalledTimes(1);
    // The failed attempt never re-read the detail either.
    expect(detailMock.fetchPrDetail).toHaveBeenCalledTimes(1);
  });

  it('any other refusal is reported as itself, without the conflict help', async () => {
    mergeApi.refreshChangeRequestFromTarget.mockRejectedValue(
      new GitApiError(403, 'Only the author of this change request, or someone who may apply it, can update it.'),
    );
    detailMock.fetchPrDetail.mockResolvedValue(detail());
    render(<ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />);

    expect(await screen.findByText(/Only the author of this change request/)).toBeInTheDocument();
    expect(screen.queryByText(/Fastest fix/)).not.toBeInTheDocument();
    // Refused, but the request is readable: the files are still shown.
    await waitFor(() => expect(screen.getByText(/1 file/)).toBeInTheDocument());
  });
});

/**
 * The guard. Every state of the dialog, rendered, searched for the default
 * branch's git name as a whole word.
 *
 * ONE carve-out, deliberate: the prompt inside `ConflictHelp` is a block of
 * verbatim data for the author's AGENT, which needs both refs to do the merge
 * it is being asked to do. It is marked as data in the prompt itself, it is
 * the one thing on the surface not addressed to the reader, and the ticket
 * keeps it as it is ("with the existing conflict help"). Everything the
 * dialog SAYS is held to the rule.
 */
function prose(container: HTMLElement): string {
  const copy = container.cloneNode(true) as HTMLElement;
  for (const block of copy.querySelectorAll('pre')) block.remove();
  return copy.textContent ?? '';
}

const NAMES_TARGET = new RegExp(`\\b${TARGET}\\b`, 'i');

describe('ChangeRequestDialog: never names the default branch to a business user', () => {
  async function rendered(over: Record<string, unknown>, settle: () => Promise<unknown>) {
    detailMock.fetchPrDetail.mockResolvedValue(detail(over));
    const { container } = render(
      <ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />,
    );
    await settle();
    return container;
  }

  it('after it has brought itself up to date', async () => {
    const c = await rendered({}, () => screen.findByText(DONE));
    expect(prose(c)).not.toMatch(NAMES_TARGET);
  });

  it('while it is bringing itself up to date', async () => {
    mergeApi.refreshChangeRequestFromTarget.mockImplementation(() => new Promise(() => {}));
    const c = await rendered({}, () => screen.findByText(RUNNING));
    expect(prose(c)).not.toMatch(NAMES_TARGET);
  });

  it('when the update conflicts', async () => {
    mergeApi.refreshChangeRequestFromTarget.mockRejectedValue(conflict());
    const c = await rendered({}, () => screen.findByRole('alert'));
    expect(prose(c)).not.toMatch(NAMES_TARGET);
  });

  it('for a viewer who may not update it', async () => {
    const c = await rendered({ viewerCanUpdate: false }, () => screen.findByText(READER_NOTICE));
    expect(prose(c)).not.toMatch(NAMES_TARGET);
  });

  it('on a deleted file — the note says whose version would go, in plain words', async () => {
    const c = await rendered(
      {
        behind: false,
        // The note only has something to sit above for a file the dialog
        // can actually SHOW the doomed version of — a document with a
        // viewer, read from the target because the request's branch no
        // longer has the path at all.
        files: [
          {
            path: 'Sales/signed-contract.pdf',
            status: 'removed' as const,
            additions: 0,
            deletions: 0,
            isBinary: true,
            sha: '',
            rawUrl: '',
          },
        ],
        approvals: [{ ...approval, path: 'Sales/signed-contract.pdf' }],
      },
      () => screen.findByText(/This request DELETES this file/),
    );
    expect(screen.getByText(/This request DELETES this file/).textContent).toContain(
      'Below is the version everyone sees today, which would go.',
    );
    expect(prose(c)).not.toMatch(NAMES_TARGET);
  });

  it("but the request's own draft name in the header row stays as it is", async () => {
    const c = await rendered({ behind: false }, () => screen.findByText(/1 file/));
    // The author's branch is theirs and is still shown; only the DEFAULT
    // branch's name is the one a business user never has to decode.
    expect(c.textContent).toContain('alice/deal-pricing');
    expect(prose(c)).not.toMatch(NAMES_TARGET);
  });
});
