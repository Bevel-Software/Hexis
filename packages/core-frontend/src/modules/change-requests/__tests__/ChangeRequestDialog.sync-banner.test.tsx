import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { FileApprovalState, PullRequestSummary } from '@bevel-software/platform-shared';

/**
 * The request's verbs push its SOURCE branch, which is rarely the branch in
 * the address bar. When the repository host refuses that push, the sync
 * banner must show in the request view — so the view watches the source
 * branch's workspace while it is open — and clear there when a later push
 * of the branch lands.
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
vi.mock('../../pr/services/pr-merge.api', () => ({
  mergePullRequest: vi.fn(),
  refreshChangeRequestFromTarget: vi.fn(),
}));
vi.mock('../../pr/services/pr-cancel.api', () => ({
  cancelPullRequest: vi.fn(),
  deleteChangeRequest: vi.fn(),
}));

import { ChangeRequestDialog } from '../components/ChangeRequestDialog';
import { GitApiError } from '../../git/services/git.api';
import { EventBusContext, type EventBusContextValue } from '../../workflow/state/event-bus.context';

const BRANCH = 'ali.raza/customer-hypotheses';
const CR = {
  number: 12,
  title: 'Customer hypotheses',
  authorId: 'abc',
  author: { login: 'user-abc', name: 'Ali' },
  appAuthor: { name: 'Ali' },
  branch: BRANCH,
  base: 'main',
  state: 'open',
  createdAt: '2026-10-07T00:00:00.000Z',
  touchedNodePaths: [],
  review: { approvals: 0, changesRequested: 0, pendingLogins: [] },
  url: '/change-requests/12',
} as unknown as PullRequestSummary;

const APPROVAL: FileApprovalState = {
  path: 'Docs/a.md',
  eligibleApprovers: { roles: ['Admin'], users: [] },
  approvedBy: [],
  isApproved: false,
  viewerCanApprove: true,
  inMergeGate: true,
};

const DETAIL = {
  ...CR,
  body: '',
  headSha: 'h',
  baseSha: 'b',
  files: [{ path: 'Docs/a.md', status: 'modified', additions: 1, deletions: 0, isBinary: false, sha: '', rawUrl: '' }],
  comments: [],
  approvals: [APPROVAL],
  mergeableInBevel: true,
  mergeBlockedReasons: [],
  mergeWarnings: [],
  viewerCanBypassMerge: false,
  viewerCanCancel: false,
};

const SENTENCE =
  `Saved locally on "${BRANCH}" but couldn't share with the team automatically — ` +
  'the repository host refused the push. The next save on this branch shares it.';

/** A stand-in for the SSE bus that records watches and lets a test push events. */
function makeBus() {
  const handlers = new Map<string, Set<(e: unknown) => void>>();
  const release = vi.fn();
  const watchWorkspace = vi.fn(() => release);
  const ctx = {
    subscribe(kind: string, handler: (e: unknown) => void) {
      const set = handlers.get(kind) ?? new Set<(e: unknown) => void>();
      set.add(handler);
      handlers.set(kind, set);
      return () => set.delete(handler);
    },
    setFocus: vi.fn(),
    watchWorkspace,
  } as unknown as EventBusContextValue;
  return {
    ctx,
    watchWorkspace,
    release,
    emit(event: Record<string, unknown> & { kind: string }) {
      act(() => {
        for (const h of handlers.get(event.kind) ?? []) h(event);
      });
    },
  };
}

function renderDialog(bus: ReturnType<typeof makeBus>) {
  return render(
    <EventBusContext.Provider value={bus.ctx}>
      <ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />
    </EventBusContext.Provider>,
  );
}

const syncBanner = () =>
  screen.queryAllByRole('alert').find((el) => el.textContent?.includes('reaching your git host')) ?? null;

beforeEach(() => {
  detailMock.fetchPrDetail.mockReset();
  approvalsApi.revertPrFile.mockReset();
  detailMock.fetchPrDetail.mockResolvedValue(DETAIL);
});

describe('ChangeRequestDialog: the source branch’s sync banner', () => {
  it('watches the source branch’s workspace while open, and lets go on close', () => {
    const bus = makeBus();
    const view = renderDialog(bus);
    // Workspace ids are the URL-encoded branch name.
    expect(bus.watchWorkspace).toHaveBeenCalledWith(encodeURIComponent(BRANCH));
    view.unmount();
    expect(bus.release).toHaveBeenCalled();
  });

  it('a revert the host refused: the sentence, and the banner naming the branch — which clears when the push lands', async () => {
    const bus = makeBus();
    approvalsApi.revertPrFile.mockRejectedValue(
      new GitApiError(409, SENTENCE, { kind: 'push-needs-resolution', branch: BRANCH }),
    );
    renderDialog(bus);

    fireEvent.contextMenu(await screen.findByTitle('Docs/a.md'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Revert file…' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Really revert this file?' }));
    await waitFor(() => expect(approvalsApi.revertPrFile).toHaveBeenCalledWith(12, 'Docs/a.md'));

    // The route's answer, verbatim — never "Internal server error".
    expect(await screen.findByText(SENTENCE)).toBeInTheDocument();
    expect(screen.queryByText(/internal (server )?error/i)).not.toBeInTheDocument();

    // The backend's banner event arrives for the source branch (decoded id).
    expect(syncBanner()).toBeNull();
    bus.emit({
      kind: 'git-sync-failed',
      workspaceId: BRANCH,
      branch: BRANCH,
      reason: 'The repository host refused the request.',
    });
    const banner = syncBanner();
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain(BRANCH);
    expect(banner?.textContent).toContain('saved here');

    // The host is back and the branch's next push lands.
    bus.emit({ kind: 'git-sync-recovered', workspaceId: BRANCH, branch: BRANCH });
    expect(syncBanner()).toBeNull();
  });

  it('ignores another branch’s failure', async () => {
    const bus = makeBus();
    renderDialog(bus);
    await screen.findByTitle('Docs/a.md');
    bus.emit({ kind: 'git-sync-failed', workspaceId: 'bob/other', branch: 'bob/other', reason: 'x' });
    expect(syncBanner()).toBeNull();
  });
});
