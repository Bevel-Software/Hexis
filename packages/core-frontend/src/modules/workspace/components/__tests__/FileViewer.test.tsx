import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { useEffect, useState } from 'react';
import type { BranchInfo, WorkingTreeStatus } from '@bevel-software/platform-shared';

// Mock the access API before importing the component tree — useFileAccess
// fires a fetch in an effect on mount, and we don't want real network in tests.
type Eligible = { roles: string[]; users: { name: string; email: string }[] };
const EMPTY_ELIGIBLE: Eligible = { roles: [], users: [] };
const accessMock = vi.hoisted(() => ({
  result: {
    canWrite: true,
    canOwner: false,
    eligible: { roles: ['Admin'], users: [] },
    owners: { roles: [], users: [] },
  } as {
    canWrite: boolean;
    canOwner: boolean;
    eligible: { roles: string[]; users: { name: string; email: string }[] };
    owners: { roles: string[]; users: { name: string; email: string }[] };
  },
  fetchFileAccess: vi.fn(),
}));
accessMock.fetchFileAccess.mockImplementation(async () => accessMock.result);
vi.mock('../../../access/api', () => ({
  fetchFileAccess: accessMock.fetchFileAccess,
  fetchFileAccessBatch: vi.fn(async () => ({ results: {} })),
}));

// Mock the lock API too — useFileLock acquires/heartbeats/releases against
// real endpoints. In these tests we just need the acquire to succeed so the
// save flow can finish; lock contention paths are exercised in lock-specific
// tests, not here.
vi.mock('../../../workflow/services/lock.api', () => ({
  acquireLock: vi.fn(async () => ({
    acquired: true,
    lock: {
      branch: 'alice/draft',
      path: 'Knowledge/Foo.md',
      holderUserId: 'u1',
      holderName: 'Test User',
      acquiredAt: new Date().toISOString(),
      lastHeartbeatAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  })),
  heartbeatLock: vi.fn(async () => ({})),
  checkpointLockedFile: vi.fn(async () => null),
  releaseLock: vi.fn(async () => null),
  getLock: vi.fn(async () => null),
  LockApiError: class LockApiError extends Error {
    readonly status: number;
    readonly body: unknown;
    constructor(status: number, message: string, body?: unknown) {
      super(message);
      this.status = status;
      this.body = body;
    }
  },
}));

// The access sheet is a 1200-line dialog with its own suite and its own
// endpoints. Here it only has to prove WHICH entry the page handed it — a file
// and its parent folder are the two share scopes, and picking the wrong one is
// the only mistake this wiring can make.
vi.mock('../../../access/components/ManageAccessDialog', () => ({
  ManageAccessDialog: ({ entry }: { entry: { relativePath: string; type: string } }) => (
    <div role="dialog" aria-label={`Manage access: ${entry.type} ${entry.relativePath}`} />
  ),
}));

// Wrap `useFileLock` rather than replacing it: every other case in this file
// depends on the real acquire/release lifecycle. The wrapper only observes
// `recordActivity`, which has no other visible effect (it resets a timer), so
// there is no way to assert the scroll→lock wiring without a spy on it.
const lockActivity = vi.hoisted(() => ({ recordActivity: vi.fn() }));
vi.mock('../../../workflow/hooks/useFileLock', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../workflow/hooks/useFileLock')>();
  const { useCallback } = await import('react');
  return {
    ...actual,
    useFileLock: (args: Parameters<typeof actual.useFileLock>[0]) => {
      const real = actual.useFileLock(args);
      const realRecord = real.recordActivity;
      // Stable identity: FileViewer's scroll effect lists `recordActivity` in
      // its deps, and a fresh function each render would re-bind the listener
      // on every render — changing exactly the behaviour under test.
      const recordActivity = useCallback(() => {
        lockActivity.recordActivity();
        realRecord();
      }, [realRecord]);
      return { ...real, recordActivity };
    },
  };
});

import { FileViewer } from '../FileViewer';
// The lock API is mocked above; import the mocked fns so individual tests can
// override the acquire outcome (e.g. a 403 on enter-edit).
import { acquireLock as acquireLockMock, LockApiError } from '../../../workflow/services/lock.api';
import { WorkspaceContext, type WorkspaceContextValue } from '../../state/workspace.context';
import { GitContext, type GitContextValue } from '../../../git/state/git.context';
import { ReviewContext, type ReviewContextValue } from '../../../review/state/review.context';
import { AuthContext, type AuthContextValue } from '../../../auth/state/auth.context';
import { PrViewerContext, type PrViewerContextValue } from '../../../pr/state/pr-viewer.context';
import { OpenChangeRequestsContext } from '../../state/open-change-requests.context';

let injectPendingFromTest: ((value?: string) => void) | null = null;
const openPrSpy = vi.fn();

function makeStatus(branch = 'alice/draft'): WorkingTreeStatus {
  return {
    branch,
    hasUpstream: true,
    unmergedFromUpstream: false,
  };
}

const fetchFileHistoryMock = vi.fn(async () => [
  {
    sha: 'abc1234',
    authorName: 'Ali Raza',
    authorEmail: 'ali@example.com',
    subject: 'Tighten the wording',
    committedAt: new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString(),
  },
]);

function makeGit(status: WorkingTreeStatus): GitContextValue {
  const branches: BranchInfo[] = [];
  return {
    status,
    branches,
    availability: 'ready',
    lastError: null,
    refreshStatus: async () => null,
    refreshBranches: async () => {},
    createBranch: async () => {},
    deleteBranch: async () => {},
    pull: async () => {},
    fetchForkBase: async () => null,
    revert: async () => ({
      sha: 'abc',
      authorName: 'n',
      authorEmail: 'e',
      subject: 's',
      committedAt: '2026-04-20T00:00:00.000Z',
    }),
    fetchFileHistory: fetchFileHistoryMock,
    fetchFileDiff: async () => '',
    fetchFileComparison: async () => '',
  };
}

function ViewerHarness({
  initialContent = 'Base content',
  pendingValue = 'Agent version',
  branch = 'alice/draft',
  filePath = 'knowledge-base/Knowledge/Foo.md',
  kbDirName = 'knowledge-base',
  addTab,
  changeRequests = [],
}: {
  initialContent?: string;
  pendingValue?: string;
  branch?: string;
  filePath?: string;
  kbDirName?: string | null;
  addTab?: WorkspaceContextValue['addTab'];
  /** Open change requests touching `filePath`. */
  changeRequests?: { number: number; title: string; who: string }[];
}) {
  const [openFileContent, setOpenFileContent] = useState(initialContent);
  const [pendingFileContent, setPendingFileContent] = useState<string | null>(null);

  useEffect(() => {
    injectPendingFromTest = (value?: string) => {
      setPendingFileContent(value ?? pendingValue);
    };
    return () => {
      injectPendingFromTest = null;
    };
  }, [pendingValue]);

  const tab = {
    path: filePath,
    content: openFileContent,
    savedContent: openFileContent,
    isDirty: false,
    pendingFileContent,
  };
  const workspace: WorkspaceContextValue = {
    workspaceId: 'ws-1',
    kbDirName,
    fileTree: null,
    openTabs: [tab],
    activeTab: tab,
    dirtyTabFilenames: [],
    openFilePath: filePath,
    openFileContent,
    openFileSavedContent: openFileContent,
    hasUnsavedFileChanges: false,
    pendingFileContent,
    setActiveTabContent: () => {},
    uploadError: null,
    isUploading: false,
    uploadProgress: null,
    pendingUploads: new Map(),
    fsRevision: 0,
    bumpFsRevision: () => {},
    setPersistenceBranch: () => {},
    refreshFileTree: async () => null,
    addTab: addTab ?? (async () => true),
    closeTab: async () => ({ closed: true, newActivePath: null }),
    activateTab: () => {},
    reorderTab: () => {},
    closeAllTabs: () => {},
    hydrateTabs: async () => ({ surviving: [], dropped: [], denied: [] }),
    createFile: async () => {},
    createDirectory: async () => {},
    unzipHere: async () => ({ extracted: 0, skipped: [], destination: '' }),
    uploadFiles: async () => {},
    dispatchUpload: async () => {},
    clearUploadError: () => {},
    deleteEntry: async () => {},
    moveEntry: async () => {},
    saveFile: async (_relativePath: string, content: string) => {
      setOpenFileContent(content);
    },
    reloadTabFromDisk: async () => {},
    setPendingContent: (content: string) => {
      setPendingFileContent(content);
    },
    acceptPendingContent: async () => {
      setOpenFileContent((curr) => pendingFileContent ?? curr);
      setPendingFileContent(null);
    },
    rejectPendingContent: async () => {
      setPendingFileContent(null);
    },
  };
  const review: ReviewContextValue = {
    session: null,
    selectedPath: null,
    fileDiff: null,
    isLoadingDiff: false,
    lastError: null,
    isLoading: false,
    refresh: async () => {},
    selectPath: async () => {},
    acceptOne: async () => {},
    rejectOne: async () => {},
    acceptAll: async () => {},
    rejectAll: async () => {},
    clearError: () => {},
  };
  const auth: AuthContextValue = {
    user: null,
    token: null,
    isLoading: false,
    login: async () => {},
    logout: () => {},
  };
  const prViewer: PrViewerContextValue = {
    openPrNumber: null,
    detail: null,
    notFound: false,
    selectedPath: null,
    isLoading: false,
    lastError: null,
    openPr: openPrSpy,
    closeViewer: () => {},
    selectPath: () => {},
    refresh: async () => {},
  };

  return (
    <MemoryRouter>
      <AuthContext.Provider value={auth}>
        <WorkspaceContext.Provider value={workspace}>
          <GitContext.Provider value={makeGit(makeStatus(branch))}>
            <ReviewContext.Provider value={review}>
              <PrViewerContext.Provider value={prViewer}>
                <OpenChangeRequestsContext.Provider
                  value={{
                    paths: new Set(changeRequests.length ? [filePath] : []),
                    forPath: (p) =>
                      p === filePath
                        ? (changeRequests.map((c) => ({
                            number: c.number,
                            title: c.title,
                            appAuthor: { name: c.who },
                            author: { login: 'bevel-bot' },
                            touchedNodePaths: ['Knowledge/Foo.md'],
                          })) as never)
                        : [],
                  }}
                >
                  <button type="button" onClick={() => setPendingFileContent(pendingValue)}>
                    Inject pending
                  </button>
                  <FileViewer />
                </OpenChangeRequestsContext.Provider>
              </PrViewerContext.Provider>
            </ReviewContext.Provider>
          </GitContext.Provider>
        </WorkspaceContext.Provider>
      </AuthContext.Provider>
    </MemoryRouter>
  );
}

describe('FileViewer', () => {
  // Restore the access mock to its default after each test so a test that
  // flips it to `canWrite: false` doesn't bleed into later tests in this file.
  afterEach(() => {
    accessMock.result = {
      canWrite: true,
      canOwner: false,
      eligible: { roles: ['Admin'], users: [] },
      owners: EMPTY_ELIGIBLE,
    };
    accessMock.fetchFileAccess.mockClear();
    // Restore the default "acquire succeeds" behaviour so a per-test 403
    // override doesn't leak into the next test.
    vi.mocked(acquireLockMock).mockImplementation(async () => ({
      acquired: true,
      lock: {
        branch: 'alice/draft',
        path: 'Knowledge/Foo.md',
        holderUserId: 'u1',
        holderName: 'Test User',
        acquiredAt: new Date().toISOString(),
        lastHeartbeatAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    }));
  });

  it('immediately enters review mode when pending arrives on a clean file', async () => {
    const user = userEvent.setup();
    render(<ViewerHarness initialContent="base clean" pendingValue="agent clean" />);

    await user.click(screen.getByRole('button', { name: 'Inject pending' }));

    expect(await screen.findByText(/Previewing agent's changes/i)).toBeInTheDocument();
    expect(screen.getByText(/Reviewing agent update/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.getByText('agent clean')).toBeInTheDocument();
  });

  it('defers pending review when unsaved manual edits exist', async () => {
    const user = userEvent.setup();
    render(<ViewerHarness initialContent="base" pendingValue="agent replacement" />);

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    await user.type(textarea, ' local edits');
    expect(textarea.value).toBe('base local edits');

    await act(async () => {
      injectPendingFromTest?.();
    });

    expect(await screen.findByText(/Agent update is waiting/i)).toBeInTheDocument();
    expect(screen.queryByText(/Previewing agent's changes/i)).not.toBeInTheDocument();
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('base local edits');
  });

  it('allows reviewing deferred pending after local save', async () => {
    const user = userEvent.setup();
    render(<ViewerHarness initialContent="base" pendingValue="agent latest" />);

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    await user.type(textarea, ' local');
    await act(async () => {
      injectPendingFromTest?.();
    });

    await user.keyboard('{Control>}s{/Control}');

    const reviewButton = await screen.findByRole('button', { name: /Review agent update/i });
    await waitFor(() => expect(reviewButton).not.toBeDisabled());
    await user.click(reviewButton);

    expect(await screen.findByText(/Previewing agent's changes/i)).toBeInTheDocument();
    expect(screen.getByText('agent latest')).toBeInTheDocument();
  });

  it('clears pending review state after accept/reject and returns to editable mode', async () => {
    const user = userEvent.setup();
    render(<ViewerHarness initialContent="base before" pendingValue="agent accepted" />);

    await user.click(screen.getByRole('button', { name: 'Inject pending' }));
    const accept = await screen.findByRole('button', { name: 'Accept' });
    await user.click(accept);

    await waitFor(() => {
      expect(screen.queryByText(/Previewing agent's changes/i)).not.toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.getByText('agent accepted')).toBeInTheDocument();

    await act(async () => {
      injectPendingFromTest?.('agent rejected');
    });
    const reject = await screen.findByRole('button', { name: 'Reject' });
    await user.click(reject);

    await waitFor(() => {
      expect(screen.queryByText(/Previewing agent's changes/i)).not.toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
  });

  // (No no-access panel tests: a tab whose read 403s AUTO-CLOSES — denied tabs
  // never exist, and the access-denied view lives at the route level. See
  // FileRoute.test.tsx's file-denied cases.)

  it('shows the canonical-state banner on a protected branch but keeps editing enabled', () => {
    // Write access is now governed by roles.yaml + access.md and enforced by
    // the backend at commit time — the editor itself is no longer disabled
    // based on branch name. The banner stays as informational copy.
    render(<ViewerHarness initialContent="official" branch="current-company-state" />);
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.getByText(/current company state/i)).toBeInTheDocument();
  });

  it('goes read-only and shows AccessRestrictedBanner when canWrite is false on a protected branch', async () => {
    // The access gate only fires on protected branches — drafts are
    // free-for-all and never reach the API, so reproducing the read-only
    // state requires a protected branch.
    accessMock.result = {
      canWrite: false,
      canOwner: false,
      eligible: { roles: ['Admin', 'Product Manager'], users: [] },
      owners: EMPTY_ELIGIBLE,
    };
    render(<ViewerHarness initialContent="official" branch="target-company-state" />);
    await waitFor(() => {
      expect(screen.getByText(/You don't have permission to edit/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/Admin, Product Manager/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  });

  // Drafts are free-for-all: even if the backend would deny at PR-merge
  // time, the editor must stay writable on a draft so the user can prepare
  // a change request. Mirrors the backend's lock/commit/push gates, which
  // all skip the access check on non-protected branches.
  it('stays editable on a draft branch even when canWrite would be false', async () => {
    accessMock.result = {
      canWrite: false,
      canOwner: false,
      eligible: { roles: ['Admin'], users: [] },
      owners: EMPTY_ELIGIBLE,
    };
    render(<ViewerHarness initialContent="draft content" branch="alice/draft" />);
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.queryByText(/You don't have permission to edit/i)).not.toBeInTheDocument();
    expect(accessMock.fetchFileAccess).not.toHaveBeenCalled();
  });

  // Bug A regression: files outside the KB are the user's own workspace.
  // Even when the backend would say "denied" for some path, a non-repo path
  // must never reach the backend — it's editable unconditionally.
  it('keeps non-repo files editable and never calls the access API', async () => {
    accessMock.result = {
      canWrite: false,
      canOwner: false,
      eligible: { roles: ['Admin'], users: [] },
      owners: EMPTY_ELIGIBLE,
    };
    render(
      <ViewerHarness
        initialContent="my scratch notes"
        branch="alice/draft"
        filePath="notes/scratch.md"
      />,
    );

    // The Edit affordance (provided by MarkdownRenderer when not readOnly) is
    // present, no banner appears, and the access lookup never fires.
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.queryByText(/You don't have permission to edit/i)).not.toBeInTheDocument();
    expect(accessMock.fetchFileAccess).not.toHaveBeenCalled();
  });

  // Bug B regression: the hook must strip the kbDirName prefix before
  // querying the backend, otherwise deeper access.md grants silently miss
  // and the editor falsely shows read-only. Exercised on a protected
  // branch because drafts skip the API entirely (drafts-are-free).
  it('strips kbDirName before calling the API for repo files', async () => {
    accessMock.result = {
      canWrite: true,
      canOwner: false,
      eligible: { roles: ['Product Manager'], users: [] },
      owners: EMPTY_ELIGIBLE,
    };
    render(
      <ViewerHarness
        initialContent="sales doc"
        branch="target-company-state"
        filePath="knowledge-base/Knowledge/Sales/Foo.md"
      />,
    );

    await waitFor(() => {
      expect(accessMock.fetchFileAccess).toHaveBeenCalledWith(
        'ws-1',
        'Knowledge/Sales/Foo.md',
      );
    });
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.queryByText(/You don't have permission to edit/i)).not.toBeInTheDocument();
  });

  // Hardening regression: when `useFileAccess` default-allows (its lookup
  // failed transiently) the Edit button is shown even on a path the backend
  // will refuse. Clicking Edit then hits a 403 on lock acquisition. Before the
  // fix that 403 was swallowed (console.warn only) and the click just flickered
  // "Loading…" then reverted to "Edit" with no explanation. Now the refusal is
  // surfaced in the save-error banner so the user understands the file is
  // read-only to them. (Distinct from lock contention, which the "Locked by X"
  // banner already covers.)
  it('surfaces an access-denied 403 on enter-edit instead of silently reverting', async () => {
    // Force the access lookup to fail → useFileAccess default-allows →
    // canWrite=true → the Edit button renders on a protected branch.
    accessMock.fetchFileAccess.mockRejectedValueOnce(new Error('network down'));
    // The authoritative backend gate refuses the lock with a 403.
    vi.mocked(acquireLockMock).mockRejectedValueOnce(
      new LockApiError(
        403,
        'You don\'t have permission to write to "Knowledge/Foo.md". Eligible: Admin.',
        { access: { path: 'Knowledge/Foo.md', eligibleRoles: ['Admin'], eligibleUsers: [] } },
      ),
    );
    const user = userEvent.setup();
    render(<ViewerHarness initialContent="official" branch="target-company-state" />);

    // Editor stays writable (default-allow) — the Edit button is present.
    const editButton = await screen.findByRole('button', { name: 'Edit' });
    await user.click(editButton);

    // The refusal is surfaced, not swallowed.
    await waitFor(() => {
      expect(
        screen.getByText(/You don't have permission to write to/i),
      ).toBeInTheDocument();
    });
    expect(screen.getByText(/Eligible: Admin/i)).toBeInTheDocument();
    // And we did NOT flip into edit mode — no editable textbox appeared.
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  // WP1 regression. The document column moved: the viewer pane used to be
  // `overflow-hidden` with a per-renderer scroller, and `editorContainerRef`
  // sat on that pane. It now sits on `KbDocumentShell`, which is what actually
  // scrolls. Scroll events do NOT bubble, so if the ref ever lands on a
  // wrapper nested inside the scroller the capture listener stops firing,
  // nothing type-errors, and a reader's lock silently auto-releases after two
  // minutes. This suite had zero scroll / recordActivity coverage before.
  it('resets the lock idle timer when the document is scrolled in edit mode', async () => {
    const user = userEvent.setup();
    lockActivity.recordActivity.mockClear();
    render(<ViewerHarness initialContent="a long document" />);

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    // Edit mode is what arms the scroll listener.
    await screen.findByRole('textbox');
    lockActivity.recordActivity.mockClear();

    const shell = screen.getByTestId('kb-document-shell');
    await act(async () => {
      shell.dispatchEvent(new Event('scroll'));
    });

    expect(lockActivity.recordActivity).toHaveBeenCalled();
  });

  it('leads the page with the document column, not a full-bleed pane', () => {
    render(<ViewerHarness initialContent="measured" />);
    const shell = screen.getByTestId('kb-document-shell');
    // A markdown file is a document, so it gets the prose measure.
    expect(shell.getAttribute('data-variant')).toBe('prose');
    // …and the tab strip lives inside it, so tabs and text share one edge.
    expect(shell.querySelector('[role="tablist"]')).not.toBeNull();
  });

  // ── WP4: the document names itself ──

  it('names the file in an h1 and keeps no 40px chrome strip', () => {
    render(<ViewerHarness initialContent="titled" />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Foo');
    // The trio of sub-tabs went behind ⋯; Content is the page now.
    expect(screen.queryByRole('button', { name: 'Content' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'History' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Compare' })).not.toBeInTheDocument();
  });

  it('opens Version history from ⋯ and offers a way back to the document', async () => {
    const user = userEvent.setup();
    render(<ViewerHarness initialContent="historic" />);

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(screen.getByRole('menuitem', { name: /Version history/ }));

    const back = await screen.findByRole('button', { name: /Back to the document/ });
    await user.click(back);
    // The document is back, and so is its Edit affordance.
    expect(await screen.findByRole('button', { name: 'Edit' })).toBeInTheDocument();
  });

  it('shares the file itself from Share, and the parent folder from the chevron', async () => {
    const user = userEvent.setup();
    render(<ViewerHarness initialContent="shared" />);

    await user.click(screen.getByRole('button', { name: 'Share' }));
    expect(
      await screen.findByRole('dialog', {
        name: 'Manage access: file knowledge-base/Knowledge/Foo.md',
      }),
    ).toBeInTheDocument();
    // And there is no second scope: sharing the whole folder starts at the
    // folder's own row in the tree, beside the children it governs.
    await user.click(screen.getByRole('button', { name: 'More sharing options' }));
    expect(screen.queryByRole('menuitem', { name: /whole folder/i })).not.toBeInTheDocument();
  });

  // ── WP5: the rail ──

  // A closed rail must cost nothing. `fetchFileHistory` is not cached and
  // `FileHistoryPanel` refetches the same history anyway, so an ungated call
  // would be one wasted request per file opened, for every reader, forever.
  it('opens the rail from ⋯ and issues no history request until it is open', async () => {
    const user = userEvent.setup();
    fetchFileHistoryMock.mockClear();
    render(<ViewerHarness initialContent="railed" />);

    expect(screen.queryByText('About this file')).not.toBeInTheDocument();
    expect(fetchFileHistoryMock).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(screen.getByRole('menuitem', { name: /File details/ }));

    expect(await screen.findByText('About this file')).toBeInTheDocument();
    expect(screen.getByText('knowledge-base/Knowledge/Foo.md')).toBeInTheDocument();
    await waitFor(() => expect(fetchFileHistoryMock).toHaveBeenCalledWith(
      'knowledge-base/Knowledge/Foo.md',
      1,
    ));
    expect(await screen.findByText(/by Ali/)).toBeInTheDocument();
  });

  // ── WP6: the third place ──

  // The D3 asymmetry, made visible: this signal comes from the BROAD endpoint,
  // so a request opened by somebody else on a file you can read but not write
  // still says so here — while the dock, which is scoped to you, stays empty.
  it('says so on the page when a file has an open change request', async () => {
    const user = userEvent.setup();
    render(
      <ViewerHarness
        initialContent="contested"
        changeRequests={[{ number: 32, title: 'Tighten the wording', who: 'Ali Raza' }]}
      />,
    );

    expect(await screen.findByText('Open change request')).toBeInTheDocument();
    expect(screen.getByText(/Ali Raza proposed/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Review the change' }));
    expect(openPrSpy).toHaveBeenCalledWith(32);
  });

  it('says nothing on a file nobody has proposed a change to', () => {
    render(<ViewerHarness initialContent="quiet" />);
    expect(screen.queryByText('Open change request')).not.toBeInTheDocument();
  });

  it('widens the column when the rail is open', async () => {
    const user = userEvent.setup();
    render(<ViewerHarness initialContent="railed" />);
    const wrap = () => screen.getByTestId('kb-document-shell').firstElementChild as HTMLElement;
    expect(wrap().className).toContain('max-w-[880px]');

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(screen.getByRole('menuitem', { name: /File details/ }));
    expect(wrap().className).toContain('max-w-[980px]');
  });
});
