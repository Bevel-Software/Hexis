import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type {
  FileApprovalState,
  PullRequestDetail,
  PullRequestFile,
  PullRequestFinished,
  PullRequestSummary,
  WorkflowEvent,
  WorkflowEventPayload,
} from '@bevel-software/platform-shared';

/**
 * A change request that was applied or closed opens in the FINISHED view
 * (hx-finished-request-says-so): one status line, no verbs, and for an
 * applied request each file's change as applied, read from its own merge
 * commit — never from the draft branch the apply removed.
 */

const detailMock = vi.hoisted(() => ({ fetchPrDetail: vi.fn() }));
vi.mock('../../pr/services/pr-detail.api', () => ({ fetchPrDetail: detailMock.fetchPrDetail }));

const crApi = vi.hoisted(() => ({
  readFileOnBranch: vi.fn(),
  readFileAtCommit: vi.fn(),
  fileExistsOnWorkspace: vi.fn(),
}));
vi.mock('../services/change-requests.api', () => crApi);

vi.mock('../services/denied-file.api', () => ({
  describeReadFailure: vi.fn(async (err: { status?: number; message?: string }) =>
    err?.status === 403
      ? { kind: 'denied', folder: 'Finance' }
      : { kind: 'error', reason: err?.message ?? 'failed' },
  ),
}));

vi.mock('../../workspace/services/workspace.api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../workspace/services/workspace.api')>();
  return {
    ...actual,
    getOrCreateWorkspace: vi.fn(async (branch: string) => ({
      workspace: { id: encodeURIComponent(branch), kbDirName: 'knowledge-base' },
    })),
  };
});

// The rendered-markdown diff has its own suite; here it only has to show
// which two sides it was handed.
vi.mock('../../review/components/MarkdownDiffViewer', () => ({
  MarkdownDiffViewer: ({ payload }: { payload: { kind: string; baseline: string | null; current: string | null } }) => (
    <div data-testid="md-diff">
      {payload.kind}|{payload.baseline ?? '∅'}|{payload.current ?? '∅'}
    </div>
  ),
}));

const forkMock = vi.hoisted(() => ({ readFileAtForkPoint: vi.fn() }));
vi.mock('../hooks/useForkPointFile', () => ({
  useForkPointFileRead: (...args: unknown[]) => {
    forkMock.readFileAtForkPoint(...args);
    return { content: null, failed: false };
  },
}));
const tipMock = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../hooks/useFileOnBranch', () => ({
  useDefaultBranchFileRead: (...args: unknown[]) => {
    tipMock.read(...args);
    return { content: null, failed: false };
  },
}));

const mergeApi = vi.hoisted(() => ({
  mergePullRequest: vi.fn(),
  refreshChangeRequestFromTarget: vi.fn(),
}));
vi.mock('../../pr/services/pr-merge.api', () => mergeApi);
vi.mock('../../pr/services/pr-approvals.api', () => ({
  approvePrFile: vi.fn(),
  revertPrFile: vi.fn(),
  unapprovePrFile: vi.fn(),
}));
vi.mock('../../pr/services/pr-cancel.api', () => ({
  cancelPullRequest: vi.fn(),
  deleteChangeRequest: vi.fn(),
}));

import { ChangeRequestDialog } from '../components/ChangeRequestDialog';
import { finishedStatusLine } from '../utils/finishedStatus';
import { EventBusContext, type EventBusContextValue } from '../../workflow/state/event-bus.context';
import { kbFileUrl, WorkspaceApiError } from '../../workspace';
import { AuthContext } from '../../auth/state/auth.context';
import { describeReadFailure } from '../services/denied-file.api';

const SHA = 'f'.repeat(40);
const APPLIED_AT = '2026-10-10T09:30:00.000Z';
const day = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

const CR: PullRequestSummary = {
  number: 7,
  title: 'Refresh the pricing pages',
  authorId: 'dana',
  author: { login: 'user-dana', name: 'Dana Admin' },
  appAuthor: { name: 'Dana Admin' },
  branch: 'suggestions/dana/knowledge',
  base: 'main',
  state: 'open',
  createdAt: '2026-10-09T09:00:00.000Z',
  touchedNodePaths: [],
  review: { approvals: 0, changesRequested: 0, pendingLogins: [] },
  url: '/change-requests/7',
};

const file = (path: string, over: Partial<PullRequestFile> = {}): PullRequestFile => ({
  path,
  status: 'modified',
  additions: 1,
  deletions: 1,
  isBinary: false,
  sha: '',
  rawUrl: '',
  ...over,
});

const approval = (path: string): FileApprovalState => ({
  path,
  eligibleApprovers: { roles: ['Admin'], users: [] },
  approvedBy: [],
  isApproved: false,
  viewerCanApprove: true,
  inMergeGate: true,
});

function detailOf(
  state: 'open' | 'merged' | 'closed',
  files: PullRequestFile[],
  finished: Partial<PullRequestFinished> | null = {},
  over: Partial<PullRequestDetail> = {},
): PullRequestDetail {
  return {
    ...CR,
    state,
    body: '',
    headSha: 'h',
    baseSha: 'b',
    files,
    comments: [],
    // Every verb the review view has would be live on these: an approval the
    // viewer can give, an update they may run, a delete they may make.
    approvals: files.map((f) => approval(f.path)),
    mergeableInBevel: true,
    mergeBlockedReasons: [],
    mergeWarnings: ['Waiting on approval from the files’ owners'],
    viewerCanBypassMerge: true,
    viewerCanCancel: true,
    mergeBaseSha: 'c'.repeat(40),
    behind: true,
    needsUpdate: true,
    viewerCanUpdate: true,
    viewerIsAuthor: true,
    viewerCanDelete: true,
    finished:
      state === 'open' || finished === null
        ? null
        : {
            at: APPLIED_AT,
            appliedBy: state === 'merged' ? { name: 'Robin Lee' } : null,
            closedReason: null,
            appliedSha: state === 'merged' ? SHA : null,
            appliedUnreadable: false,
            ...finished,
          },
    ...over,
  } as PullRequestDetail;
}

/** before/after text per path, as the merge commit holds it. */
function commitHolds(sides: Record<string, { before?: string; after?: string }>) {
  crApi.readFileAtCommit.mockImplementation(
    async (_ws: string, workspacePath: string, _sha: string, side: 'after' | 'before') => {
      const path = workspacePath.replace(/^knowledge-base\//, '');
      const text = sides[path]?.[side];
      if (text === undefined) throw new WorkspaceApiError(404);
      return text;
    },
  );
}

function fakeBus() {
  const handlers = new Map<string, Set<(e: WorkflowEvent) => void>>();
  const value: EventBusContextValue = {
    subscribe: (kind, handler) => {
      const set = handlers.get(kind) ?? new Set();
      set.add(handler as (e: WorkflowEvent) => void);
      handlers.set(kind, set);
      return () => set.delete(handler as (e: WorkflowEvent) => void);
    },
    setFocus: () => {},
    watchWorkspace: () => () => {},
  };
  const emit = (event: WorkflowEventPayload) => {
    for (const h of handlers.get(event.kind) ?? []) {
      h({ id: 1, ts: new Date().toISOString(), ...event } as WorkflowEvent);
    }
  };
  return { value, emit };
}

function LocationProbe() {
  const location = useLocation();
  return <p data-testid="location">{location.pathname}</p>;
}

function renderDialog(
  over: { cr?: PullRequestSummary; onClose?: () => void; onOpenPage?: (url: string) => void } = {},
) {
  return render(
    <MemoryRouter initialEntries={['/change-requests/7']}>
      <AuthContext.Provider value={{ user: { email: 'sam@bevel.software' } } as never}>
        <Routes>
          <Route
            path="*"
            element={
              <>
                <LocationProbe />
                <ChangeRequestDialog
                  cr={over.cr ?? { ...CR, state: 'merged' }}
                  onClose={over.onClose ?? (() => {})}
                  onResolved={() => {}}
                  onOpenPage={over.onOpenPage}
                />
              </>
            }
          />
        </Routes>
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

/** Nothing the review view decides with, and nothing its broken read said. */
function expectNoReviewControls() {
  for (const name of [
    'Approve this file',
    'Approved – Undo',
    'Apply changes',
    'Bypass approval and apply',
    'Delete request',
    'Approve all mine',
  ]) {
    expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
  }
  expect(screen.queryByText(/Waiting on/)).not.toBeInTheDocument();
  expect(screen.queryByText(/Your approval is needed/)).not.toBeInTheDocument();
  expect(screen.queryByText(/Every agent that connects/)).not.toBeInTheDocument();
  expect(screen.queryByText(/Checking against the latest version/)).not.toBeInTheDocument();
  expect(screen.queryByText(/What everyone sees has changed/)).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Approved by you')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Waiting on your approval')).not.toBeInTheDocument();
  expect(screen.queryByText(/HTTP 410/)).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  expect(mergeApi.refreshChangeRequestFromTarget).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  crApi.fileExistsOnWorkspace.mockResolvedValue(true);
  crApi.readFileOnBranch.mockRejectedValue(new Error('HTTP 410'));
});

describe('finishedStatusLine', () => {
  const NOW = Date.parse(APPLIED_AT) + 3 * 24 * 3600_000;

  it('names the applier and the day', () => {
    expect(finishedStatusLine(detailOf('merged', []), NOW)).toBe(`Applied by Robin Lee on ${day(APPLIED_AT)}.`);
  });

  it('says "just now" within the first minute after the apply', () => {
    expect(finishedStatusLine(detailOf('merged', []), Date.parse(APPLIED_AT) + 30_000)).toBe(
      'Applied by Robin Lee just now.',
    );
    // A server clock a little ahead of this one is still "just now".
    expect(finishedStatusLine(detailOf('merged', []), Date.parse(APPLIED_AT) - 5_000)).toBe(
      'Applied by Robin Lee just now.',
    );
    expect(finishedStatusLine(detailOf('merged', []), Date.parse(APPLIED_AT) + 61_000)).toBe(
      `Applied by Robin Lee on ${day(APPLIED_AT)}.`,
    );
  });

  it('falls back to the day alone when no applier is recorded', () => {
    expect(finishedStatusLine(detailOf('merged', [], { appliedBy: null }), NOW)).toBe(
      `Applied on ${day(APPLIED_AT)}.`,
    );
  });

  it('says a closed request applied nothing', () => {
    expect(finishedStatusLine(detailOf('closed', []), NOW)).toBe(
      `Closed on ${day(APPLIED_AT)}. Nothing from it was applied.`,
    );
  });

  it('names the one recorded close reason: the knowledge base moved', () => {
    expect(finishedStatusLine(detailOf('closed', [], { closedReason: 'repository-replaced' }), NOW)).toBe(
      `Closed on ${day(APPLIED_AT)} when the knowledge base moved to another repository. Nothing from it was applied.`,
    );
  });
});

describe('ChangeRequestDialog: an applied request', () => {
  const FILES = [
    file('Docs/pricing.yaml', { additions: 2, deletions: 1 }),
    file('Docs/new.yaml', { status: 'added', additions: 1, deletions: 0 }),
    file('Docs/old.yaml', { status: 'removed', additions: 0, deletions: 3 }),
  ];

  beforeEach(() => {
    commitHolds({
      'Docs/pricing.yaml': { before: 'tier: basic\n', after: 'tier: premium\nprice: 10\n' },
      'Docs/new.yaml': { after: 'brand: new\n' },
      'Docs/old.yaml': { before: 'gone: soon\n' },
    });
  });

  it('shows the status line in the neutral notice bar, and no review control at all', async () => {
    detailMock.fetchPrDetail.mockResolvedValue(detailOf('merged', FILES));
    renderDialog();
    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent(`Applied by Robin Lee on ${day(APPLIED_AT)}.`);
    await screen.findByText('tier: premium');
    expectNoReviewControls();
    // The removed draft branch is never read.
    expect(crApi.readFileOnBranch).not.toHaveBeenCalled();
  });

  it('shows each file as applied, read from its own merge commit, and counts that change', async () => {
    detailMock.fetchPrDetail.mockResolvedValue(detailOf('merged', FILES));
    renderDialog();
    expect(await screen.findByText(/3 files ·/)).toHaveTextContent('3 files · +3 −4');
    const removed = await screen.findByText('tier: basic');
    expect(removed.tagName).toBe('DEL');
    expect(screen.getByText('tier: premium').tagName).toBe('INS');
    expect(crApi.readFileAtCommit).toHaveBeenCalledWith('main', 'knowledge-base/Docs/pricing.yaml', SHA, 'after');
    expect(crApi.readFileAtCommit).toHaveBeenCalledWith('main', 'knowledge-base/Docs/pricing.yaml', SHA, 'before');
    // Not the open request's reads either: no fork point, no target tip.
    expect(forkMock.readFileAtForkPoint.mock.calls.every((c) => c[1] === null)).toBe(true);
    expect(tipMock.read.mock.calls.every((c) => c[0] === null)).toBe(true);
  });

  it('offers Open page to the page as it is now on the branch it was applied to', async () => {
    const onClose = vi.fn();
    detailMock.fetchPrDetail.mockResolvedValue(detailOf('merged', FILES));
    renderDialog({ onClose });
    const open = await screen.findByRole('link', { name: 'Open page' });
    const url = kbFileUrl('main', 'knowledge-base/Docs/pricing.yaml');
    expect(open).toHaveAttribute('href', url);
    expect(crApi.fileExistsOnWorkspace).toHaveBeenCalledWith('main', 'knowledge-base/Docs/pricing.yaml');
    fireEvent.click(open);
    expect(screen.getByTestId('location')).toHaveTextContent(url);
    expect(onClose).toHaveBeenCalled();
  });

  it('hands Open page to a host that navigates itself', async () => {
    const onOpenPage = vi.fn();
    const onClose = vi.fn();
    detailMock.fetchPrDetail.mockResolvedValue(detailOf('merged', FILES));
    renderDialog({ onOpenPage, onClose });
    fireEvent.click(await screen.findByRole('link', { name: 'Open page' }));
    expect(onOpenPage).toHaveBeenCalledWith(kbFileUrl('main', 'knowledge-base/Docs/pricing.yaml'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('an added file also offers Open page', async () => {
    detailMock.fetchPrDetail.mockResolvedValue(detailOf('merged', FILES));
    renderDialog();
    await screen.findByText('tier: premium');
    fireEvent.click(screen.getByRole('button', { name: 'new.yaml' }));
    expect(await screen.findByText('brand: new')).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'Open page' })).toHaveAttribute(
      'href',
      kbFileUrl('main', 'knowledge-base/Docs/new.yaml'),
    );
    // Nothing read on the before side of a file the request added.
    expect(crApi.readFileAtCommit).not.toHaveBeenCalledWith('main', 'knowledge-base/Docs/new.yaml', SHA, 'before');
  });

  it('says "This page has since been deleted." when the page is gone, and still shows the change', async () => {
    crApi.fileExistsOnWorkspace.mockResolvedValue(false);
    detailMock.fetchPrDetail.mockResolvedValue(detailOf('merged', FILES));
    renderDialog();
    expect(await screen.findByText('This page has since been deleted.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open page' })).not.toBeInTheDocument();
    expect(screen.getByText('tier: premium')).toBeInTheDocument();
  });

  describe('with the real existence check behind Open page', () => {
    // The helper itself, not a mock of it: only `fetch` is stubbed, so what
    // the HEAD answers is what the view is told.
    beforeEach(async () => {
      const actual = await vi.importActual<typeof import('../services/change-requests.api')>(
        '../services/change-requests.api',
      );
      crApi.fileExistsOnWorkspace.mockImplementation(actual.fileExistsOnWorkspace);
    });
    afterEach(() => vi.unstubAllGlobals());

    it.each([
      ['a 500', () => Promise.resolve(new Response(null, { status: 500 })), 'HTTP 500'],
      ['a network drop', () => Promise.reject(new TypeError('Failed to fetch')), 'Failed to fetch'],
    ])('%s is a failed read with Try again, never "Open page" or "deleted"', async (_name, failure, reason) => {
      const fetchMock = vi.fn().mockImplementationOnce(failure).mockResolvedValue(new Response(null, { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);
      detailMock.fetchPrDetail.mockResolvedValue(detailOf('merged', FILES));
      renderDialog();
      expect(await screen.findByText(new RegExp(`couldn't be read right now \\(${reason}\\)`))).toBeInTheDocument();
      expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'HEAD' });
      expect(screen.queryByRole('link', { name: 'Open page' })).not.toBeInTheDocument();
      expect(screen.queryByText('This page has since been deleted.')).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      expect(await screen.findByRole('link', { name: 'Open page' })).toHaveAttribute(
        'href',
        kbFileUrl('main', 'knowledge-base/Docs/pricing.yaml'),
      );
    });

    it('a 404 is the page deleted since', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 404 })));
      detailMock.fetchPrDetail.mockResolvedValue(detailOf('merged', FILES));
      renderDialog();
      expect(await screen.findByText('This page has since been deleted.')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    });
  });

  it('a file the request itself deleted shows neither, and its text as removed', async () => {
    crApi.fileExistsOnWorkspace.mockResolvedValue(false);
    detailMock.fetchPrDetail.mockResolvedValue(detailOf('merged', FILES));
    renderDialog();
    await screen.findByText('tier: premium');
    fireEvent.click(screen.getByRole('button', { name: 'old.yaml' }));
    const gone = await screen.findByText('gone: soon');
    expect(gone.tagName).toBe('DEL');
    expect(screen.queryByRole('link', { name: 'Open page' })).not.toBeInTheDocument();
    expect(screen.queryByText('This page has since been deleted.')).not.toBeInTheDocument();
    expect(crApi.fileExistsOnWorkspace).not.toHaveBeenCalledWith('main', 'knowledge-base/Docs/old.yaml');
  });

  it('reads a renamed file’s before side at its old path', async () => {
    commitHolds({
      'Docs/renamed.yaml': { after: 'kept: yes\nadded: line\n' },
      'Docs/original.yaml': { before: 'kept: yes\n' },
    });
    detailMock.fetchPrDetail.mockResolvedValue(
      detailOf('merged', [file('Docs/renamed.yaml', { status: 'renamed', previousPath: 'Docs/original.yaml' })]),
    );
    renderDialog();
    expect(await screen.findByText('added: line')).toBeInTheDocument();
    expect(screen.getByText('Moved: Docs/original.yaml → Docs/renamed.yaml')).toBeInTheDocument();
    expect(crApi.readFileAtCommit).toHaveBeenCalledWith('main', 'knowledge-base/Docs/original.yaml', SHA, 'before');
  });

  it('names where a copied file came from', async () => {
    commitHolds({
      'Docs/copy.yaml': { after: 'kept: yes\n' },
      'Docs/source.yaml': { before: 'kept: yes\n' },
    });
    detailMock.fetchPrDetail.mockResolvedValue(
      detailOf('merged', [file('Docs/copy.yaml', { status: 'copied', previousPath: 'Docs/source.yaml' })]),
    );
    renderDialog();
    expect(await screen.findByText('Copied: Docs/source.yaml → Docs/copy.yaml')).toBeInTheDocument();
  });

  it('a refused before side of a rename is described for the OLD path, whose owners lift it', async () => {
    crApi.readFileAtCommit.mockImplementation(
      async (_ws: string, _workspacePath: string, _sha: string, side: string) => {
        if (side === 'before') throw new WorkspaceApiError(403);
        return 'kept: yes\n';
      },
    );
    detailMock.fetchPrDetail.mockResolvedValue(
      detailOf('merged', [file('Sales/renamed.yaml', { status: 'renamed', previousPath: 'Finance/original.yaml' })]),
    );
    renderDialog();
    expect(await screen.findByText(/You don't have access to read this file/)).toBeInTheDocument();
    expect(describeReadFailure).toHaveBeenCalledWith(expect.anything(), 'main', 'Finance/original.yaml');
    expect(describeReadFailure).not.toHaveBeenCalledWith(expect.anything(), 'main', 'Sales/renamed.yaml');
  });

  it('a deleted binary with no viewer is still gated, and locks for a reader who may not read it', async () => {
    crApi.fileExistsOnWorkspace.mockRejectedValue(new WorkspaceApiError(403));
    detailMock.fetchPrDetail.mockResolvedValue(
      detailOf('merged', [file('Finance/terms.zip', { status: 'removed', isBinary: true })]),
    );
    renderDialog();
    expect(await screen.findByText(/You don't have access to read this file/)).toBeInTheDocument();
    expect(crApi.fileExistsOnWorkspace).toHaveBeenCalledWith('main', 'knowledge-base/Finance/terms.zip');
    expect(screen.queryByText(/binary file .* this request deleted/)).not.toBeInTheDocument();
  });

  it('renders a markdown file as applied through the document diff', async () => {
    commitHolds({ 'Docs/page.md': { before: '# Old', after: '# New' } });
    detailMock.fetchPrDetail.mockResolvedValue(detailOf('merged', [file('Docs/page.md')]));
    renderDialog();
    expect(await screen.findByTestId('md-diff')).toHaveTextContent('modified|# Old|# New');
  });

  it('a read that fails for another reason says so, with the usual retry', async () => {
    crApi.readFileAtCommit.mockRejectedValueOnce(new WorkspaceApiError(500, 'git timed out'));
    commitHolds({ 'Docs/pricing.yaml': { before: 'tier: basic\n', after: 'tier: premium\n' } });
    crApi.readFileAtCommit.mockRejectedValueOnce(new WorkspaceApiError(500, 'git timed out'));
    detailMock.fetchPrDetail.mockResolvedValue(detailOf('merged', [file('Docs/pricing.yaml')]));
    renderDialog();
    expect(await screen.findByText(/couldn't be read right now \(git timed out\)/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('tier: premium')).toBeInTheDocument();
  });

  it('without a merge commit of its own, lists its files with Open page and no "as applied" diff', async () => {
    detailMock.fetchPrDetail.mockResolvedValue(
      detailOf('merged', [file('Docs/pricing.yaml', { additions: 2, deletions: 1 }), file('Docs/new.yaml', { status: 'added', deletions: 0 })], {
        appliedSha: null,
      }),
    );
    renderDialog();
    expect(await screen.findByText(/made no change of its own to show/)).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Applied by Robin Lee');
    // The file list and its scale, as the ticket asks.
    expect(screen.getByText(/2 files ·/)).toHaveTextContent('2 files · +3 −1');
    expect(screen.getAllByRole('treeitem').map((r) => r.textContent)).toEqual(['pricing.yaml', 'new.yaml']);
    expect(await screen.findByRole('link', { name: 'Open page' })).toHaveAttribute(
      'href',
      kbFileUrl('main', 'knowledge-base/Docs/pricing.yaml'),
    );
    expect(screen.queryByText(/· as applied/)).not.toBeInTheDocument();
    // Never a diff, so never a read of any commit.
    expect(crApi.readFileAtCommit).not.toHaveBeenCalled();
    expectNoReviewControls();
  });

  it('a recorded merge commit that could not be read never claims nothing was applied', async () => {
    detailMock.fetchPrDetail.mockResolvedValue(
      detailOf('merged', [file('Docs/pricing.yaml', { additions: 2, deletions: 1 })], {
        appliedSha: null,
        appliedUnreadable: true,
      }),
    );
    renderDialog();
    expect(await screen.findByText(/change as it was applied can't be read right now/)).toBeInTheDocument();
    expect(screen.queryByText(/already there when it was applied/)).not.toBeInTheDocument();
    expect(screen.queryByText(/made no change of its own/)).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Applied by Robin Lee');
    expect(screen.getAllByRole('treeitem').map((r) => r.textContent)).toEqual(['pricing.yaml']);
    expect(screen.queryByText(/· as applied/)).not.toBeInTheDocument();
    expect(crApi.readFileAtCommit).not.toHaveBeenCalled();
    expectNoReviewControls();
  });

  it('without a merge commit of its own, still locks a file the reader may not read', async () => {
    crApi.fileExistsOnWorkspace.mockRejectedValue(new WorkspaceApiError(403));
    detailMock.fetchPrDetail.mockResolvedValue(
      detailOf('merged', [file('Finance/Payment terms.yaml')], { appliedSha: null }),
    );
    renderDialog();
    expect(await screen.findByText(/You don't have access to read this file/)).toBeInTheDocument();
    const row = screen.getByRole('treeitem');
    expect(within(row).getByRole('img', { name: /You don't have access/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open page' })).not.toBeInTheDocument();
    expect(screen.queryByText(/made no change of its own/)).not.toBeInTheDocument();
  });

  it('without a merge commit of its own, a failed read says so with Try again, never "already there"', async () => {
    crApi.fileExistsOnWorkspace.mockRejectedValueOnce(new WorkspaceApiError(500, 'git timed out'));
    detailMock.fetchPrDetail.mockResolvedValue(
      detailOf('merged', [file('Docs/pricing.yaml')], { appliedSha: null }),
    );
    renderDialog();
    expect(await screen.findByText(/couldn't be read right now \(git timed out\)/)).toBeInTheDocument();
    expect(screen.queryByText(/made no change of its own/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(/made no change of its own/)).toBeInTheDocument();
  });

  it('without a merge commit of its own, says nothing of success while the page check is pending', async () => {
    let reject!: (err: unknown) => void;
    crApi.fileExistsOnWorkspace.mockImplementationOnce(
      () =>
        new Promise<boolean>((_, no) => {
          reject = no;
        }),
    );
    detailMock.fetchPrDetail.mockResolvedValue(
      detailOf('merged', [file('Docs/pricing.yaml')], { appliedSha: null }),
    );
    renderDialog();
    await waitFor(() => expect(crApi.fileExistsOnWorkspace).toHaveBeenCalled());
    expect(await screen.findByText('Loading…')).toBeInTheDocument();
    expect(screen.queryByText(/made no change of its own/)).not.toBeInTheDocument();
    reject(new WorkspaceApiError(500, 'git timed out'));
    expect(await screen.findByText(/couldn't be read right now \(git timed out\)/)).toBeInTheDocument();
    expect(screen.queryByText(/made no change of its own/)).not.toBeInTheDocument();
  });

  it('with no files and no commit of its own, is the status line in a compact dialog', async () => {
    detailMock.fetchPrDetail.mockResolvedValue(detailOf('merged', [], { appliedSha: null }));
    renderDialog();
    await screen.findByRole('status');
    expect(screen.queryByText(/files? ·/)).not.toBeInTheDocument();
    expect(screen.queryByText(/doesn't change anything anymore/)).not.toBeInTheDocument();
    expect(screen.queryByRole('tree')).not.toBeInTheDocument();
    expectNoReviewControls();
  });
});

describe('ChangeRequestDialog: an applied request, as a partial reader', () => {
  it('locks the file the reader may not read and shows none of it; the others show their change', async () => {
    crApi.readFileAtCommit.mockImplementation(
      async (_ws: string, workspacePath: string, _sha: string, side: string) => {
        if (workspacePath.includes('Finance/')) throw new WorkspaceApiError(403);
        return side === 'before' ? 'region: eu\n' : 'region: us\n';
      },
    );
    detailMock.fetchPrDetail.mockResolvedValue(
      detailOf('merged', [file('Finance/Payment terms.yaml'), file('Sales/Pitch.yaml')]),
    );
    renderDialog();
    // The first file is the refused one: its sentence, no content, a lock.
    expect(await screen.findByText(/You don't have access to read this file/)).toBeInTheDocument();
    expect(screen.queryByText('region: us')).not.toBeInTheDocument();
    const lockedRow = screen.getAllByRole('treeitem').find((r) => r.textContent?.includes('Payment terms'))!;
    expect(within(lockedRow).getByRole('img', { name: /You don't have access/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open page' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Pitch.yaml' }));
    expect(await screen.findByText('region: us')).toBeInTheDocument();
    // The lock stays on the row the reader moved past.
    expect(within(lockedRow).getByRole('img', { name: /You don't have access/ })).toBeInTheDocument();
  });

  it('locks a binary file the reader may not read', async () => {
    crApi.fileExistsOnWorkspace.mockRejectedValue(new WorkspaceApiError(403));
    detailMock.fetchPrDetail.mockResolvedValue(
      detailOf('merged', [file('Finance/terms.zip', { isBinary: true })]),
    );
    renderDialog();
    const row = await screen.findByRole('treeitem');
    await waitFor(() => expect(within(row).getByRole('img', { name: /You don't have access/ })).toBeInTheDocument());
    expect(screen.queryByRole('link', { name: 'Open page' })).not.toBeInTheDocument();
  });
});

describe('ChangeRequestDialog: a closed request', () => {
  it('is its header, description and status line — no file count, list or content, compact', async () => {
    detailMock.fetchPrDetail.mockResolvedValue(
      detailOf('closed', [], {}, { body: 'The pricing pages were out of date.\n\n## Affected owners\n- x' }),
    );
    renderDialog({ cr: { ...CR, state: 'closed' } });
    expect(await screen.findByRole('status')).toHaveTextContent(
      `Closed on ${day(APPLIED_AT)}. Nothing from it was applied.`,
    );
    expect(screen.getByRole('heading', { name: CR.title })).toBeInTheDocument();
    expect(screen.getByText('Dana Admin')).toBeInTheDocument();
    expect(screen.getByText(CR.branch)).toBeInTheDocument();
    expect(screen.getByText('The pricing pages were out of date.')).toBeInTheDocument();
    expect(screen.queryByText(/files? ·/)).not.toBeInTheDocument();
    expect(screen.queryByRole('tree')).not.toBeInTheDocument();
    expect(screen.queryByText(/doesn't change anything anymore/)).not.toBeInTheDocument();
    expect(screen.queryByText(/You can delete it below/)).not.toBeInTheDocument();
    // Fits its contents rather than taking the full height.
    const surface = screen.getByRole('dialog').querySelector('.max-w-6xl')!;
    expect(surface.classList.contains('h-[92vh]')).toBe(false);
    expectNoReviewControls();
    expect(crApi.readFileOnBranch).not.toHaveBeenCalled();
  });

  it("keeps the author's own headings, and drops only the generated owners block", async () => {
    detailMock.fetchPrDetail.mockResolvedValue(
      detailOf('closed', [], {}, {
        body: 'Why.\n\n## Background\n\nThe old pages.\n\n## Affected owners\n\n- `Docs/a.md` — Admin',
      }),
    );
    renderDialog({ cr: { ...CR, state: 'closed' } });
    await screen.findByRole('status');
    expect(screen.getByText(/## Background/)).toBeInTheDocument();
    expect(screen.getByText(/The old pages\./)).toBeInTheDocument();
    expect(screen.queryByText(/Affected owners/)).not.toBeInTheDocument();
  });

  it('prints no HTML comment, an author\'s or Hexis\'s, as the view did before', async () => {
    detailMock.fetchPrDetail.mockResolvedValue(
      detailOf('closed', [], {}, {
        body: 'Why. <!-- note from the author: keep this short -->\n<!--hexis:author-id:abc-->\n<!-- bevel/marker -->',
      }),
    );
    renderDialog({ cr: { ...CR, state: 'closed' } });
    await screen.findByRole('status');
    expect(screen.getByText('Why.')).toBeInTheDocument();
    expect(screen.queryByText(/<!--/)).not.toBeInTheDocument();
    expect(screen.queryByText(/keep this short/)).not.toBeInTheDocument();
    expect(screen.queryByText(/hexis:author-id/)).not.toBeInTheDocument();
  });

  it('an OPEN request\'s description prints no HTML comment either (unchanged by this ticket)', async () => {
    crApi.readFileOnBranch.mockResolvedValue('tier: premium\n');
    detailMock.fetchPrDetail.mockResolvedValue(
      detailOf('open', [file('Docs/pricing.yaml')], null, {
        needsUpdate: false,
        behind: false,
        body: 'Why. <!-- note from the author: keep this short -->',
      }),
    );
    renderDialog({ cr: CR });
    expect(await screen.findByText('Why.')).toBeInTheDocument();
    expect(screen.queryByText(/<!--/)).not.toBeInTheDocument();
    expect(screen.queryByText(/keep this short/)).not.toBeInTheDocument();
  });

  it('names the move of the knowledge base when that is why it closed', async () => {
    detailMock.fetchPrDetail.mockResolvedValue(detailOf('closed', [], { closedReason: 'repository-replaced' }));
    renderDialog({ cr: { ...CR, state: 'closed' } });
    expect(await screen.findByRole('status')).toHaveTextContent(
      'when the knowledge base moved to another repository. Nothing from it was applied.',
    );
  });
});

describe('ChangeRequestDialog: opened from a link that already says it is finished', () => {
  it('says why when the detail cannot be loaded, rather than loading forever', async () => {
    detailMock.fetchPrDetail.mockRejectedValue(new Error('Change request #7 could not be read.'));
    renderDialog({ cr: { ...CR, state: 'merged' } });
    expect(await screen.findByRole('alert')).toHaveTextContent('Change request #7 could not be read.');
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
    expectNoReviewControls();
  });

  it('never shows the review view while the detail loads', () => {
    detailMock.fetchPrDetail.mockReturnValue(new Promise(() => {}));
    renderDialog({ cr: { ...CR, state: 'merged' } });
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    expect(screen.queryByText('Measuring the change…')).not.toBeInTheDocument();
    expectNoReviewControls();
  });
});

describe('ChangeRequestDialog: finished while open', () => {
  const FILES = [file('Docs/pricing.yaml')];
  // Up to date, so opening it runs no bring-up-to-date of its own: what is
  // asserted below is the switch, not the open request's machinery.
  const openDetail = () => detailOf('open', FILES, null, { needsUpdate: false, behind: false });

  function renderOpen(bus: ReturnType<typeof fakeBus>) {
    return render(
      <MemoryRouter>
        <EventBusContext.Provider value={bus.value}>
          <ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />
        </EventBusContext.Provider>
      </MemoryRouter>,
    );
  }

  it('an open request is the review view, unchanged', async () => {
    crApi.readFileOnBranch.mockResolvedValue('tier: premium\n');
    detailMock.fetchPrDetail.mockResolvedValue(openDetail());
    renderOpen(fakeBus());
    expect(await screen.findByRole('button', { name: 'Approve this file' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete request' })).toBeInTheDocument();
    expect(screen.queryByText(/Applied by/)).not.toBeInTheDocument();
  });

  it('switches to the finished view when someone else applies it', async () => {
    const bus = fakeBus();
    crApi.readFileOnBranch.mockResolvedValue('tier: premium\n');
    commitHolds({ 'Docs/pricing.yaml': { before: 'tier: basic\n', after: 'tier: premium\n' } });
    detailMock.fetchPrDetail.mockResolvedValue(openDetail());
    renderOpen(bus);
    expect(await screen.findByRole('button', { name: 'Approve this file' })).toBeInTheDocument();

    detailMock.fetchPrDetail.mockResolvedValue(
      detailOf('merged', FILES, { at: new Date().toISOString() }),
    );
    act(() => bus.emit({ kind: 'change-request-merged', number: 7 }));
    expect(await screen.findByText('Applied by Robin Lee just now.')).toBeInTheDocument();
    expect(detailMock.fetchPrDetail).toHaveBeenLastCalledWith(7, { fresh: true });
    expectNoReviewControls();
  });

  it('switches to the closed view when it is closed', async () => {
    const bus = fakeBus();
    crApi.readFileOnBranch.mockResolvedValue('tier: premium\n');
    detailMock.fetchPrDetail.mockResolvedValue(openDetail());
    renderOpen(bus);
    expect(await screen.findByRole('button', { name: 'Delete request' })).toBeInTheDocument();

    detailMock.fetchPrDetail.mockResolvedValue(detailOf('closed', []));
    act(() => bus.emit({ kind: 'change-request-rejected', number: 7 }));
    expect(await screen.findByText(`Closed on ${day(APPLIED_AT)}. Nothing from it was applied.`)).toBeInTheDocument();
    expectNoReviewControls();
    expect(screen.queryByRole('tree')).not.toBeInTheDocument();
  });

  it('ignores another request closing', async () => {
    const bus = fakeBus();
    crApi.readFileOnBranch.mockResolvedValue('tier: premium\n');
    detailMock.fetchPrDetail.mockResolvedValue(openDetail());
    renderOpen(bus);
    await screen.findByRole('button', { name: 'Delete request' });
    act(() => bus.emit({ kind: 'change-request-rejected', number: 99 }));
    expect(detailMock.fetchPrDetail).toHaveBeenCalledTimes(1);
  });
});
