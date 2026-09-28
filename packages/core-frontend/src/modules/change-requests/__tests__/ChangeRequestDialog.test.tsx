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
const approvalsApi = vi.hoisted(() => ({ approvePrFile: vi.fn(), revertPrFile: vi.fn(), unapprovePrFile: vi.fn() }));
vi.mock('../../pr/services/pr-approvals.api', () => ({
  approvePrFile: approvalsApi.approvePrFile,
  revertPrFile: approvalsApi.revertPrFile,
  unapprovePrFile: approvalsApi.unapprovePrFile,
}));
const mergeApi = vi.hoisted(() => ({
  mergePullRequest: vi.fn(),
  refreshChangeRequestFromTarget: vi.fn(),
}));
vi.mock('../../pr/services/pr-merge.api', () => ({
  mergePullRequest: mergeApi.mergePullRequest,
  refreshChangeRequestFromTarget: mergeApi.refreshChangeRequestFromTarget,
}));
const cancelApi = vi.hoisted(() => ({ deleteChangeRequest: vi.fn() }));
vi.mock('../../pr/services/pr-cancel.api', () => ({
  cancelPullRequest: vi.fn(),
  deleteChangeRequest: cancelApi.deleteChangeRequest,
}));

import { ChangeRequestDialog } from '../components/ChangeRequestDialog';
import { AuthContext } from '../../auth/state/auth.context';
import { readFileOnBranch } from '../services/change-requests.api';
import { GitApiError } from '../../git/services/git.api';

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
  mergeApi.refreshChangeRequestFromTarget.mockReset();
  cancelApi.deleteChangeRequest.mockReset();
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
  inMergeGate: true,
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
    expect(await screen.findByText('Waiting on Admin')).toBeInTheDocument();
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

  it('one file pending for the viewer: the header approves it, the footer counts it', async () => {
    detailMock.fetchPrDetail.mockResolvedValue(
      detailWith([approval({ viewerCanApprove: true })]),
    );
    approvalsApi.approvePrFile.mockResolvedValue([
      approval({
        viewerCanApprove: true,
        isApproved: true,
        approvedBy: [
          { email: 'olga@bevel.software', name: 'Olga', approvedAt: '', isStale: false, isSelfApproval: false },
        ],
      }),
    ]);
    render(
      <AuthContext.Provider
        value={{ user: { id: 'u1', email: 'olga@bevel.software', name: 'Olga' } } as never}
      >
        <ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />
      </AuthContext.Provider>,
    );
    expect(await screen.findByText('Your approval is needed on 1 file')).toBeInTheDocument();
    // One file needs no "all" button.
    expect(screen.queryByRole('button', { name: 'Approve all mine' })).not.toBeInTheDocument();
    // The tree's check is status, not a control.
    expect(screen.getByRole('img', { name: 'Waiting on your approval' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Confirm Docs/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Approve this file' }));
    expect(approvalsApi.approvePrFile).toHaveBeenCalledWith(12, 'Docs/a.md');
    expect(await screen.findByRole('button', { name: 'Approved – Undo' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Approved by you' })).toBeInTheDocument();
    expect(screen.queryByText(/Your approval is needed/)).not.toBeInTheDocument();
  });

  it('the header button sits right after the header text in the tab order', async () => {
    detailMock.fetchPrDetail.mockResolvedValue(
      detailWith([approval({ viewerCanApprove: true })]),
    );
    render(<ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />);
    const button = await screen.findByRole('button', { name: 'Approve this file' });
    const header = screen.getByText(/what changes is marked/);
    expect(button.previousElementSibling).toBe(header);
    expect(button).not.toHaveAttribute('tabindex');
  });

  it('two files pending: "Approve all mine" approves both, one after the other', async () => {
    detailMock.fetchPrDetail.mockResolvedValue(
      detailWith([
        approval({ path: 'Docs/a.md', viewerCanApprove: true }),
        approval({ path: 'Docs/b.md', viewerCanApprove: true }),
      ]),
    );
    approvalsApi.approvePrFile.mockReset();
    approvalsApi.approvePrFile
      .mockResolvedValueOnce([
        approval({ path: 'Docs/a.md', viewerCanApprove: true, isApproved: true }),
        approval({ path: 'Docs/b.md', viewerCanApprove: true }),
      ])
      .mockResolvedValueOnce([
        approval({ path: 'Docs/a.md', viewerCanApprove: true, isApproved: true }),
        approval({ path: 'Docs/b.md', viewerCanApprove: true, isApproved: true }),
      ]);
    render(<ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />);
    expect(await screen.findByText('Your approval is needed on 2 files')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Approve all mine' }));
    await waitFor(() => expect(approvalsApi.approvePrFile).toHaveBeenCalledTimes(2));
    expect(approvalsApi.approvePrFile).toHaveBeenNthCalledWith(1, 12, 'Docs/a.md');
    expect(approvalsApi.approvePrFile).toHaveBeenNthCalledWith(2, 12, 'Docs/b.md');
    expect(await screen.findByRole('button', { name: 'Apply changes' })).toBeInTheDocument();
    expect(screen.queryByText(/Your approval is needed/)).not.toBeInTheDocument();
  });

  it('none pending for the viewer: no header button, the footer names who it waits on', async () => {
    detailMock.fetchPrDetail.mockResolvedValue(
      detailWith([
        approval({
          eligibleApprovers: { roles: ['Legal'], users: [{ name: 'Juan', email: 'juan@bevel.software' }] },
        }),
      ]),
    );
    render(<ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />);
    expect(await screen.findByText('Waiting on Legal, Juan')).toBeInTheDocument();
    expect(screen.queryByText(/Your approval is needed/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve this file' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approved – Undo' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve all mine' })).not.toBeInTheDocument();
  });

  it("undo: the viewer's own approval reads Approved – Undo, and pressing it withdraws", async () => {
    detailMock.fetchPrDetail.mockResolvedValue(
      detailWith([
        approval({
          viewerCanApprove: true,
          isApproved: true,
          approvedBy: [
            { email: 'olga@bevel.software', name: 'Olga', approvedAt: '', isStale: false, isSelfApproval: false },
          ],
        }),
      ]),
    );
    approvalsApi.unapprovePrFile.mockResolvedValue([approval({ viewerCanApprove: true })]);
    render(
      <AuthContext.Provider
        value={{ user: { id: 'u1', email: 'olga@bevel.software', name: 'Olga' } } as never}
      >
        <ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />
      </AuthContext.Provider>,
    );
    expect(await screen.findByRole('img', { name: 'Approved by you' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Approved – Undo' }));
    await waitFor(() => expect(approvalsApi.unapprovePrFile).toHaveBeenCalledWith(12, 'Docs/a.md'));
    expect(await screen.findByRole('button', { name: 'Approve this file' })).toBeInTheDocument();
    expect(screen.getByText('Your approval is needed on 1 file')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Waiting on your approval' })).toBeInTheDocument();
  });

  it('confirmed by someone else: waits on nobody, but the header still lets the viewer add theirs', async () => {
    detailMock.fetchPrDetail.mockResolvedValue(
      detailWith([
        approval({
          viewerCanApprove: true,
          isApproved: true,
          approvedBy: [
            { email: 'juan@bevel.software', name: 'Juan', approvedAt: '', isStale: false, isSelfApproval: false },
          ],
        }),
      ]),
    );
    render(
      <AuthContext.Provider
        value={{ user: { id: 'u1', email: 'olga@bevel.software', name: 'Olga' } } as never}
      >
        <ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />
      </AuthContext.Provider>,
    );
    expect(await screen.findByRole('button', { name: 'Apply changes' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Confirmed by Admin' })).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'Waiting on your approval' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Your approval is needed/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve this file' })).toBeInTheDocument();
  });

  it('files outside the merge gate hold nothing up and name nobody', async () => {
    detailMock.fetchPrDetail.mockResolvedValue(
      detailWith([
        approval({ path: 'Docs/a.md', isApproved: true }),
        // The server says the gate ignores it (not markdown), owner named or not.
        approval({
          path: 'assets/shot.png',
          eligibleApprovers: { roles: ['Legal'], users: [] },
          inMergeGate: false,
        }),
      ]),
    );
    render(<ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />);
    expect(await screen.findByRole('button', { name: 'Apply changes' })).toBeInTheDocument();
    expect(screen.queryByText(/Waiting on/)).not.toBeInTheDocument();
    // Nor does the tree's badge on the ignored file.
    expect(screen.queryByRole('img', { name: /Waiting on/ })).not.toBeInTheDocument();
  });

  it('Apply records approvals only on files the gate binds', async () => {
    detailMock.fetchPrDetail.mockResolvedValue(
      detailWith([
        approval({ path: 'Docs/a.md', viewerCanApprove: true }),
        approval({
          path: 'assets/shot.png',
          eligibleApprovers: { roles: ['Admin'], users: [] },
          viewerCanApprove: true,
          inMergeGate: false,
        }),
      ]),
    );
    approvalsApi.approvePrFile.mockReset();
    approvalsApi.approvePrFile.mockResolvedValue([]);
    render(<ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Bypass approval and apply' }));
    await waitFor(() => expect(approvalsApi.approvePrFile).toHaveBeenCalledWith(12, 'Docs/a.md'));
    // The approving loop is over once the merge step is named.
    expect(await screen.findByRole('button', { name: 'Applying…' })).toBeInTheDocument();
    expect(approvalsApi.approvePrFile).not.toHaveBeenCalledWith(12, 'assets/shot.png');
  });

  it('while applying, the approve controls stand down', async () => {
    const twoPending = detailWith([
      approval({ path: 'Docs/a.md', viewerCanApprove: true }),
      approval({ path: 'Docs/b.md', viewerCanApprove: true }),
    ]);
    detailMock.fetchPrDetail.mockResolvedValue(twoPending);
    approvalsApi.approvePrFile.mockReset();
    approvalsApi.approvePrFile.mockReturnValue(new Promise(() => {}));
    render(<ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Bypass approval and apply' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Approve this file' })).toBeDisabled(),
    );
    expect(screen.getByRole('button', { name: 'Approve all mine' })).toBeDisabled();
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

  /**
   * Delete is the author's verb as much as the admin's. The dialog asks the
   * server one question — `viewerCanDelete` — so these tests never encode
   * "is this an admin"; that decision lives on the server, beside the DELETE
   * route that enforces it.
   */
  it('shows Delete request whenever the server says the viewer may delete, arms, then deletes and resolves', async () => {
    detailMock.fetchPrDetail.mockResolvedValue({
      ...detailWith([approval({})]),
      // An author with no admin rights: exactly the case that used to see
      // nothing here.
      viewerCanBypassMerge: false,
      viewerCanDelete: true,
      viewerIsAuthor: true,
    });
    cancelApi.deleteChangeRequest.mockResolvedValue(undefined);
    const onResolved = vi.fn();
    render(<ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={onResolved} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Delete request' }));
    // Nothing sent yet — the armed second click is the verdict.
    expect(cancelApi.deleteChangeRequest).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole('button', { name: `Really delete request and branch ${CR.branch}?` }),
    );
    await waitFor(() => expect(cancelApi.deleteChangeRequest).toHaveBeenCalledWith(12));
    await waitFor(() => expect(onResolved).toHaveBeenCalled());
  });

  it('shows no Delete request when the server says the viewer may not delete', async () => {
    // A signed-in stranger, or an owner of every changed file: they may
    // decline, never destroy.
    detailMock.fetchPrDetail.mockResolvedValue({
      ...detailWith([approval({})]),
      viewerCanDelete: false,
      viewerIsAuthor: false,
    });
    render(<ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />);
    await screen.findByText('Waiting on Admin');
    expect(screen.queryByRole('button', { name: 'Delete request' })).not.toBeInTheDocument();
  });

  it('an admin reads exactly the wording the author reads', async () => {
    // Same request, same branch, different viewer: the sentence must not
    // change with who is looking — only with which branch is at stake.
    detailMock.fetchPrDetail.mockResolvedValue({
      ...detailWith([approval({})]),
      viewerCanBypassMerge: true,
      viewerCanDelete: true,
      viewerIsAuthor: false,
    });
    render(<ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete request' }));
    expect(
      screen.getByRole('button', { name: `Really delete request and branch ${CR.branch}?` }),
    ).toBeInTheDocument();
  });

  it('names a draft branch in the armed confirmation', async () => {
    const named = { ...CR, branch: 'juan/fix-copy' } as PullRequestSummary;
    detailMock.fetchPrDetail.mockResolvedValue({
      ...detailWith([approval({})]),
      branch: 'juan/fix-copy',
      viewerCanDelete: true,
      viewerIsAuthor: true,
    });
    render(<ChangeRequestDialog cr={named} onClose={() => {}} onResolved={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete request' }));
    // The branch is about to be removed for good; the confirmation says which.
    expect(
      screen.getByRole('button', { name: 'Really delete request and branch juan/fix-copy?' }),
    ).toBeInTheDocument();
  });

  it('keeps the generic wording for a platform-made suggestions branch', async () => {
    // The author never chose `suggestions/ali/...`; the platform did. Naming it
    // would ask them to confirm a path they cannot recognise.
    const suggested = { ...CR, branch: 'suggestions/ali/notes' } as PullRequestSummary;
    detailMock.fetchPrDetail.mockResolvedValue({
      ...detailWith([approval({})]),
      branch: 'suggestions/ali/notes',
      viewerCanDelete: true,
      viewerIsAuthor: true,
    });
    render(<ChangeRequestDialog cr={suggested} onClose={() => {}} onResolved={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete request' }));
    expect(
      screen.getByRole('button', { name: 'Really delete request and branch?' }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/suggestions\/ali\/notes\?/)).not.toBeInTheDocument();
  });

  it('Keep disarms without sending anything', async () => {
    detailMock.fetchPrDetail.mockResolvedValue({
      ...detailWith([approval({})]),
      viewerCanDelete: true,
      viewerIsAuthor: true,
    });
    render(<ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete request' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
    // Back to the unarmed label, and nothing was asked of the server.
    expect(await screen.findByRole('button', { name: 'Delete request' })).toBeInTheDocument();
    expect(cancelApi.deleteChangeRequest).not.toHaveBeenCalled();
  });

  it('reports the server’s refusal in the dialog and leaves the request alone', async () => {
    detailMock.fetchPrDetail.mockResolvedValue({
      ...detailWith([approval({})]),
      viewerCanDelete: true,
      viewerIsAuthor: true,
    });
    // Applied between opening the dialog and confirming.
    cancelApi.deleteChangeRequest.mockRejectedValue(
      new Error('This change request has already been applied.'),
    );
    const onResolved = vi.fn();
    render(<ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={onResolved} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete request' }));
    fireEvent.click(
      screen.getByRole('button', { name: `Really delete request and branch ${CR.branch}?` }),
    );
    expect(
      await screen.findByText('This change request has already been applied.'),
    ).toBeInTheDocument();
    // The dialog stays open — nothing was removed, so nothing is resolved.
    expect(onResolved).not.toHaveBeenCalled();
  });

  it('still offers Delete on a request stuck on a conflict', async () => {
    // The stuck request is the one its author most wants to throw away and
    // propose again, which is why the button is no longer hidden while the
    // dialog is blocked. Reached the way the dialog really reaches it: the
    // auto-update on open is refused as conflicting.
    detailMock.fetchPrDetail.mockResolvedValue({
      ...detailWith([approval({})]),
      behind: true,
      viewerCanUpdate: true,
      viewerCanDelete: true,
      viewerIsAuthor: true,
    });
    mergeApi.refreshChangeRequestFromTarget.mockRejectedValue(
      new GitApiError(409, 'conflicts', { kind: 'change-request-conflicts' }),
    );
    render(<ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />);

    // The blocked state is on screen…
    expect(await screen.findByText(/Nothing changes for anyone until/)).toBeInTheDocument();
    // …and Delete is there with it, armed wording intact.
    fireEvent.click(await screen.findByRole('button', { name: 'Delete request' }));
    expect(
      screen.getByRole('button', { name: `Really delete request and branch ${CR.branch}?` }),
    ).toBeInTheDocument();
  });

  it('points the author at Delete when nothing is left to change, and names them for everyone else', async () => {
    const empty = {
      ...detailWith([]),
      files: [],
      approvals: [],
      viewerCanDelete: true,
    };
    detailMock.fetchPrDetail.mockResolvedValue({ ...empty, viewerIsAuthor: true });
    const { unmount } = render(
      <ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />,
    );
    // Withdraw is not in this dialog; Delete is, right below this sentence.
    expect(await screen.findByText(/You can delete it below\./)).toBeInTheDocument();
    expect(screen.queryByText(/can withdraw it/)).not.toBeInTheDocument();
    unmount();

    detailMock.fetchPrDetail.mockResolvedValue({ ...empty, viewerIsAuthor: false });
    render(<ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />);
    // Third person, first name only — the author is who can clear it up.
    expect(await screen.findByText(/Ali can delete it\./)).toBeInTheDocument();
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
    await screen.findByText('Waiting on Admin');
    expect(screen.queryByRole('button', { name: 'Accept file' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Revert file' })).not.toBeInTheDocument();
  });
});

/**
 * The bytes of an image in a change request live on the request's branch, and
 * a screenshot the request adds is not in the checked-out tree at all. The
 * dialog passes no resolver, so the viewer names each image instead of
 * showing another revision's copy (`?ref=` in TODOS.md is the way to show it).
 */
describe('ChangeRequestDialog: images in a markdown diff', () => {
  it("names a workspace image the request adds instead of showing the checked-out tree's copy", async () => {
    detailMock.fetchPrDetail.mockResolvedValue(
      detailWith([approval({ path: 'Docs/a.md', isApproved: true })]),
    );
    vi.mocked(readFileOnBranch).mockImplementation(async (branch: string) =>
      branch === CR.branch ? 'text\n\n![Shot](./assets/shot.png)\n' : 'text\n',
    );
    try {
      const { container } = render(
        <ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />,
      );
      expect(
        await screen.findByRole('img', { name: /Image not shown: \.\/assets\/shot.png/ }),
      ).toBeInTheDocument();
      expect(container.querySelector('img')).toBeNull();
    } finally {
      vi.mocked(readFileOnBranch).mockImplementation(async () => 'branch copy');
    }
  });
});
