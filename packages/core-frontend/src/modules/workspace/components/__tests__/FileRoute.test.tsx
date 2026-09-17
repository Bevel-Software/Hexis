import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation, useNavigate } from 'react-router-dom';
import type { ReactNode } from 'react';

// The node-id lookup behind the canonical-URL redirect, so a test can say a
// file HAS an id without a backend.
const routesMock = vi.hoisted(() => ({
  fetchNodeId: vi.fn(),
  fetchNodeWorkspacePath: vi.fn(),
}));
vi.mock('../../routing/kb-routes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../routing/kb-routes')>();
  return {
    ...actual,
    fetchNodeId: routesMock.fetchNodeId,
    fetchNodeWorkspacePath: routesMock.fetchNodeWorkspacePath,
  };
});
import type { WorkingTreeStatus } from '@bevel-software/platform-shared';
import { FileRoute } from '../FileRoute';
import { WorkspaceApiError } from '../../services/workspace.api';
import { GitContext, type GitContextValue } from '../../../git/state/git.context';
import {
  WorkspaceContext,
  type WorkspaceContextValue,
  type OpenTab,
  type HydrateResult,
} from '../../state/workspace.context';
import { makeWorkspaceFixture } from '../../__tests__/testFixtures';
import { ReviewContext, type ReviewContextValue } from '../../../review/state/review.context';
import { AuthContext, type AuthContextValue } from '../../../auth/state/auth.context';

function makeStatus(branch = 'alice/draft'): WorkingTreeStatus {
  return { branch, hasUpstream: true, unmergedFromUpstream: false };
}

function makeGit(overrides: Partial<GitContextValue> = {}): GitContextValue {
  const status = overrides.status ?? makeStatus();
  return {
    status,
    branches: [],
    availability: 'ready',
    lastError: null,
    refreshStatus: async () => null,
    refreshBranches: async () => {},
    createBranch: async () => {},
    deleteBranch: async () => {},
    pull: async () => {},
    fetchForkBase: async () => null,
    fetchFileHistory: async () => [],
    fetchFileDiff: async () => '',
    fetchFileAtChange: async () => ({ baseline: null, current: null }),
    fetchFileComparison: async () => '',
    ...overrides,
  };
}

function makeTab(overrides: Partial<OpenTab> & { path: string }): OpenTab {
  const content = overrides.content ?? `content:${overrides.path}`;
  return {
    path: overrides.path,
    content,
    savedContent: overrides.savedContent ?? content,
    isDirty: overrides.isDirty ?? false,
    pendingFileContent: overrides.pendingFileContent ?? null,
  };
}

function makeWorkspace(overrides: Partial<WorkspaceContextValue> = {}): WorkspaceContextValue {
  const openTabs = overrides.openTabs ?? [];
  const activeTab = overrides.activeTab ?? null;
  const dirtyTabFilenames = overrides.dirtyTabFilenames
    ?? openTabs.filter((t) => t.isDirty).map((t) => {
      const i = t.path.lastIndexOf('/');
      return i >= 0 ? t.path.slice(i + 1) : t.path;
    });
  const hasUnsavedFileChanges = overrides.hasUnsavedFileChanges ?? dirtyTabFilenames.length > 0;
  return makeWorkspaceFixture({
    // Left unset on purpose: `renderAt` fills it from the git status branch,
    // because in production "the branch this workspace IS" and "the branch its
    // status reports" are one fact seen twice. A test that means them to
    // disagree — a branch switch caught in flight — names it explicitly.
    workspaceBranch: overrides.workspaceBranch ?? null,
    openTabs,
    activeTab,
    dirtyTabFilenames,
    openFilePath: overrides.openFilePath ?? activeTab?.path ?? null,
    openFileContent: overrides.openFileContent ?? activeTab?.content ?? null,
    openFileSavedContent: overrides.openFileSavedContent ?? activeTab?.savedContent ?? null,
    hasUnsavedFileChanges,
    pendingFileContent: overrides.pendingFileContent ?? activeTab?.pendingFileContent ?? null,
    ...overrides,
  });
}

/** One place owns the hydrateTabs result shape, so contract changes touch one line. */
function makeHydrateResult(overrides: Partial<HydrateResult> = {}): HydrateResult {
  return { surviving: [], dropped: [], denied: [], superseded: false, ...overrides };
}

function LocationProbe() {
  const location = useLocation();
  return <div aria-label="pathname">{location.pathname}</div>;
}

/** Stands in for a file-tree click: navigates to a clean file URL. */
function TreeClickProbe() {
  const navigate = useNavigate();
  return (
    <button type="button" aria-label="tree-click-bar" onClick={() => navigate('/workspace/main/Knowledge/Bar.md')} />
  );
}

/** Two tree clicks on the SAME branch, for the URL→URL→URL sequences. */
function SameBranchClickProbe() {
  const navigate = useNavigate();
  return (
    <>
      <button
        type="button"
        aria-label="click-foo"
        onClick={() => navigate('/workspace/alice%2Fdraft/Knowledge/Foo.md')}
      />
      <button
        type="button"
        aria-label="click-baz"
        onClick={() => navigate('/workspace/alice%2Fdraft/Knowledge/Baz.md')}
      />
    </>
  );
}

function renderAt(
  url: string,
  opts: { git?: GitContextValue; workspace?: WorkspaceContextValue; canonicalize?: boolean } = {},
): {
  workspace: WorkspaceContextValue;
  git: GitContextValue;
  rerenderWorkspace: (next: WorkspaceContextValue) => void;
  rerenderGit: (next: GitContextValue) => void;
} {
  let git = opts.git ?? makeGit();
  /**
   * A workspace that hasn't said which branch it is, is on the branch its
   * status reports — the two only differ while a switch is in flight, and a
   * test that means that says so. Without this, every fixture would silently
   * describe a state the app cannot be in (a workspace on `main` whose status
   * reports `alice/draft`), which `FileRoute` now correctly refuses to read
   * from.
   */
  const onStatusBranch = (ws: WorkspaceContextValue): WorkspaceContextValue =>
    ws.workspaceBranch === null && ws.workspaceId !== null
      ? { ...ws, workspaceBranch: git.status?.branch ?? null }
      : ws;
  let workspace = onStatusBranch(opts.workspace ?? makeWorkspace());
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

  function Tree({ children }: { children: ReactNode }) {
    return (
      <AuthContext.Provider value={auth}>
        <WorkspaceContext.Provider value={workspace}>
          <GitContext.Provider value={git}>
            <ReviewContext.Provider value={review}>
                {children}
            </ReviewContext.Provider>
          </GitContext.Provider>
        </WorkspaceContext.Provider>
      </AuthContext.Provider>
    );
  }

  const tree = () => (
    <MemoryRouter initialEntries={[url]}>
      <Tree>
        <Routes>
          <Route path="/workspace/:branch/*" element={<FileRoute canonicalize={opts.canonicalize} />} />
        </Routes>
        <LocationProbe />
        <TreeClickProbe />
        <SameBranchClickProbe />
      </Tree>
    </MemoryRouter>
  );
  const { rerender } = render(tree());

  return {
    workspace,
    git,
    rerenderWorkspace: (next) => {
      workspace = onStatusBranch(next);
      rerender(tree());
    },
    rerenderGit: (next) => {
      git = next;
      rerender(tree());
    },
  };
}

/** Let every pending microtask and effect settle, to assert something did NOT happen. */
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });

beforeEach(() => {
  routesMock.fetchNodeId.mockReset().mockResolvedValue(null);
  routesMock.fetchNodeWorkspacePath.mockReset().mockResolvedValue(null);
});

describe('FileRoute: the canonical id URL', () => {
  const PATH = 'Plugins/GTM/web-search.tool';
  function openOn(): { workspace: WorkspaceContextValue; git: GitContextValue } {
    const tab = makeTab({ path: PATH });
    const workspace = makeWorkspace({
      openTabs: [tab],
      activeTab: tab,
      hydrateTabs: vi.fn<WorkspaceContextValue['hydrateTabs']>(async () => makeHydrateResult({ surviving: [PATH] })),
    });
    return { workspace, git: makeGit({ status: makeStatus('main') }) };
  }

  it('replaces the path URL with the node-id URL once the file is the open tab', async () => {
    routesMock.fetchNodeId.mockResolvedValue('web_search');
    renderAt(`/workspace/main/${PATH}`, openOn());
    await waitFor(() =>
      expect(screen.getByLabelText('pathname')).toHaveTextContent('/workspace/main/web_search'),
    );
  });

  it('keeps the path URL when canonicalising is off — the Library frame renders it there, and an id URL is no library location', async () => {
    routesMock.fetchNodeId.mockResolvedValue('web_search');
    renderAt(`/workspace/main/${PATH}`, { ...openOn(), canonicalize: false });
    // Give the (absent) redirect every chance to fire before asserting it did not.
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByLabelText('pathname')).toHaveTextContent(`/workspace/main/${PATH}`);
    expect(routesMock.fetchNodeId).not.toHaveBeenCalled();
  });
});

describe('FileRoute', () => {
  it('hydrates tabs with the URL path when branch matches', async () => {
    const hydrateTabs = vi.fn<WorkspaceContextValue['hydrateTabs']>(
      async () => makeHydrateResult({ surviving: ['Knowledge/Foo.md'] }),
    );
    const setPersistenceBranch = vi.fn();
    const workspace = makeWorkspace({ hydrateTabs, setPersistenceBranch });
    const git = makeGit({ status: makeStatus('alice/draft') });

    renderAt('/workspace/alice%2Fdraft/Knowledge/Foo.md', { git, workspace });

    await waitFor(() => {
      expect(hydrateTabs).toHaveBeenCalled();
      const [paths, activePath] = hydrateTabs.mock.calls[0];
      expect(paths).toContain('Knowledge/Foo.md');
      expect(activePath).toBe('Knowledge/Foo.md');
    });
    expect(setPersistenceBranch).toHaveBeenCalledWith('alice/draft');
  });

  /**
   * A branch name may legitimately contain a percent sign. The router already
   * percent-decodes path params, so decoding again read `my%20branch` as
   * `my branch` and bootstrapped the workspace under a branch nobody has.
   */
  it('takes the branch as the router decoded it, percent sign and all', async () => {
    const setPersistenceBranch = vi.fn();
    const workspace = makeWorkspace({
      hydrateTabs: vi.fn<WorkspaceContextValue['hydrateTabs']>(async () =>
        makeHydrateResult({ surviving: ['Knowledge/Foo.md'] }),
      ),
      setPersistenceBranch,
    });
    const git = makeGit({ status: makeStatus('my%20branch') });

    renderAt('/workspace/my%2520branch/Knowledge/Foo.md', { git, workspace });

    await waitFor(() => expect(setPersistenceBranch).toHaveBeenCalledWith('my%20branch'));
  });

  it('redirects to the new branch via setPersistenceBranch when URL points elsewhere (no git checkout)', async () => {
    // Under the per-branch workspace model, "switching branches" in
    // FileRoute is just calling setPersistenceBranch — useWorkspaceState
    // then bootstraps the destination workspace from its own per-branch
    // clone. There is NO git.switchBranch / git checkout step on the
    // source workspace's clone.
    const setPersistenceBranch = vi.fn();
    const hydrateTabs = vi.fn<WorkspaceContextValue['hydrateTabs']>(
      async () => makeHydrateResult({ surviving: ['Knowledge/Foo.md'] }),
    );
    const workspace = makeWorkspace({ hydrateTabs, setPersistenceBranch });
    const git = makeGit({ status: makeStatus('alice/draft') });

    renderAt('/workspace/target-company-state/Knowledge/Foo.md', { git, workspace });

    await waitFor(() => {
      expect(setPersistenceBranch).toHaveBeenCalledWith('target-company-state');
    });
  });

  // Working-tree dirty state no longer gates branch switching — lock release
  // auto-commits and pushes, so the only "dirty" signal that can survive a
  // switch is in-memory tab content. The next test covers that.

  it('blocks the switch when ANY tab is dirty (renderer typed-but-unsaved edits)', () => {
    // The only thing FileRoute does on a non-dirty branch change is call
    // setPersistenceBranch. With a dirty tab it must NOT call it — the
    // "Save your changes" gate is the whole point.
    const setPersistenceBranch = vi.fn();
    const git = makeGit({ status: makeStatus('alice/draft') });
    const dirtyTab = makeTab({ path: 'Knowledge/InProgress.md', isDirty: true });
    const cleanTab = makeTab({ path: 'Knowledge/Other.md' });
    const workspace = makeWorkspace({
      openTabs: [cleanTab, dirtyTab],
      activeTab: cleanTab,
      hasUnsavedFileChanges: true,
      dirtyTabFilenames: ['InProgress.md'],
      setPersistenceBranch,
    });

    renderAt('/workspace/target-company-state/Knowledge/Foo.md', { git, workspace });

    expect(
      screen.getByText(/Save your changes before opening this link/i),
    ).toBeInTheDocument();
    // The dirty banner now lists every dirty filename, not just the active one.
    expect(screen.getByText('InProgress.md')).toBeInTheDocument();
    expect(setPersistenceBranch).not.toHaveBeenCalled();
  });

  it('renders file-not-found when the URL deeplinks a path that 404s during hydrate', async () => {
    const hydrateTabs = vi.fn(async () => makeHydrateResult({ dropped: ['Knowledge/Missing.md'] }));
    const workspace = makeWorkspace({ hydrateTabs });
    const git = makeGit({ status: makeStatus('alice/draft') });

    renderAt('/workspace/alice%2Fdraft/Knowledge/Missing.md', { git, workspace });

    await waitFor(() => {
      expect(screen.getByText(/File not found/i)).toBeInTheDocument();
    });
  });

  it('renders the access-denied view when the URL deeplinks a path that 403s during hydrate', async () => {
    // The denied tab itself auto-closes (hydrateTabs drops it); the route
    // explains why nothing opened.
    const hydrateTabs = vi.fn(async () => makeHydrateResult({ denied: ['Knowledge/Restricted.md'] }));
    const workspace = makeWorkspace({ hydrateTabs });
    const git = makeGit({ status: makeStatus('alice/draft') });

    renderAt('/workspace/alice%2Fdraft/Knowledge/Restricted.md', { git, workspace });

    await waitFor(() => {
      expect(screen.getByText(/You don't have access to this file/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/File not found/i)).not.toBeInTheDocument();
  });

  it('renders the branch-gone screen when hydrate answers 410 — the branch was deleted on the host', async () => {
    const hydrateTabs = vi.fn(async () => {
      throw new WorkspaceApiError(410);
    });
    const workspace = makeWorkspace({ hydrateTabs });
    const git = makeGit({ status: makeStatus('alice/draft') });

    renderAt('/workspace/alice%2Fdraft/Knowledge/Foo.md', { git, workspace });

    await waitFor(() => {
      expect(screen.getByText(/This branch no longer exists/i)).toBeInTheDocument();
    });
    expect(screen.getByText('alice/draft')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Go to/ })).toBeInTheDocument();
    expect(screen.queryByText(/Couldn't load this file/i)).not.toBeInTheDocument();
  });
  it('renders the branch-gone screen when the BOOTSTRAP of the URL branch answered 410', async () => {
    // No workspace ever came up for this branch: GET /workspace said the
    // branch is gone. The state surfaces that; the route must not sit waiting.
    const workspace = makeWorkspace({ bootstrapError: { branch: 'alice/draft', status: 410, message: 'Gone' } });
    const git = makeGit({ status: makeStatus('main') });

    renderAt('/workspace/alice%2Fdraft/Knowledge/Foo.md', { git, workspace });

    await waitFor(() => {
      expect(screen.getByText(/This branch no longer exists/i)).toBeInTheDocument();
    });
  });

  it('a stale bootstrap failure from another branch does not paint over this one', async () => {
    const workspace = makeWorkspace({ bootstrapError: { branch: 'someone/else', status: 410, message: 'Gone' } });
    const git = makeGit({ status: makeStatus('alice/draft') });

    renderAt('/workspace/alice%2Fdraft/Knowledge/Foo.md', { git, workspace });

    await waitFor(() => {
      expect(screen.queryByText(/This branch no longer exists/i)).not.toBeInTheDocument();
    });
  });
  it('renders file-load-failed when hydrate throws a non-404 error', async () => {
    const hydrateTabs = vi.fn(async () => {
      throw new WorkspaceApiError(500);
    });
    const workspace = makeWorkspace({ hydrateTabs });
    const git = makeGit({ status: makeStatus('alice/draft') });

    renderAt('/workspace/alice%2Fdraft/Knowledge/Foo.md', { git, workspace });

    await waitFor(() => {
      expect(screen.getByText(/Couldn't load this file/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/File not found/i)).not.toBeInTheDocument();
  });

  it('Retry on a failed load re-fetches via addTab and clears the error on success', async () => {
    const hydrateTabs = vi.fn(async () => {
      throw new WorkspaceApiError(500);
    });
    // addTab resolves: the second attempt (the retry) succeeds, so the error
    // view must give way to the FileViewer.
    const addTab = vi.fn<WorkspaceContextValue['addTab']>(async () => true);
    const workspace = makeWorkspace({ hydrateTabs, addTab });
    const git = makeGit({ status: makeStatus('alice/draft') });

    renderAt('/workspace/alice%2Fdraft/Knowledge/Foo.md', { git, workspace });

    const retry = await screen.findByRole('button', { name: /retry/i });
    expect(addTab).not.toHaveBeenCalled();

    fireEvent.click(retry);

    await waitFor(() => {
      expect(addTab).toHaveBeenCalledWith('Knowledge/Foo.md');
      // Error cleared → the "Couldn't load this file" panel is gone.
      expect(screen.queryByText(/Couldn't load this file/i)).not.toBeInTheDocument();
    });
  });

  it('Retry that fails with a 403 switches to the access-denied view (no tab opened)', async () => {
    const hydrateTabs = vi.fn(async () => {
      throw new WorkspaceApiError(500);
    });
    const addTab = vi.fn<WorkspaceContextValue['addTab']>(async () => {
      throw new WorkspaceApiError(403);
    });
    const workspace = makeWorkspace({ hydrateTabs, addTab });
    const git = makeGit({ status: makeStatus('alice/draft') });

    renderAt('/workspace/alice%2Fdraft/Knowledge/Foo.md', { git, workspace });

    const retry = await screen.findByRole('button', { name: /retry/i });
    fireEvent.click(retry);

    await waitFor(() => {
      expect(addTab).toHaveBeenCalledWith('Knowledge/Foo.md');
      // A 403 gets its own view, distinct from the generic load failure —
      // and the retry button remains for a just-granted-access recovery.
      expect(screen.getByText(/You don't have access to this file/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/Couldn't load this file/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeEnabled();
  });

  it('hydrates with no active path when the URL has no path segment', async () => {
    // Empty localStorage → readPersistedTabs returns { paths: [], activePath: null },
    // and FileRoute computes `activePath = pathFromUrl || persisted.activePath`.
    // With pathFromUrl empty too, hydrateTabs is invoked with null.
    localStorage.clear();
    const hydrateTabs = vi.fn<WorkspaceContextValue['hydrateTabs']>(
      async () => makeHydrateResult(),
    );
    const workspace = makeWorkspace({ hydrateTabs });
    const git = makeGit({ status: makeStatus('alice/draft') });

    renderAt('/workspace/alice%2Fdraft', { git, workspace });

    await waitFor(() => {
      expect(hydrateTabs).toHaveBeenCalled();
      const [, activePath] = hydrateTabs.mock.calls[0];
      expect(activePath).toBeNull();
    });
  });
});

/**
 * The page is never silently blank. Every reason a file can fail to appear —
 * a bootstrap that failed, a git status that won't answer, a read still in
 * flight — has a screen that says so, and the ones that can recover have a
 * Retry. The generic "Open a page to start reading." belongs to a URL that
 * names no file, and to nothing else.
 */
describe('FileRoute: nothing waits silently', () => {
  it('shows a bootstrap failure of ANY status, names the branch and the failure, and recovers on Retry', async () => {
    const retryBootstrap = vi.fn();
    const hydrateTabs = vi.fn<WorkspaceContextValue['hydrateTabs']>(
      async () => makeHydrateResult({ surviving: ['Knowledge/Foo.md'] }),
    );
    const git = makeGit({ status: makeStatus('alice/draft') });
    const { rerenderWorkspace } = renderAt('/workspace/alice%2Fdraft/Knowledge/Foo.md', {
      git,
      workspace: makeWorkspace({
        bootstrapError: { branch: 'alice/draft', status: 500, message: 'HTTP 500' },
        retryBootstrap,
        hydrateTabs,
      }),
    });

    expect(await screen.findByText(/Couldn't open alice\/draft/)).toBeInTheDocument();
    // Names what failed, not just that something did.
    expect(screen.getByText(/failed with HTTP 500/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(retryBootstrap).toHaveBeenCalledTimes(1);

    // The retried bootstrap succeeds: the failure screen gives way to the file.
    const tab = makeTab({ path: 'Knowledge/Foo.md' });
    rerenderWorkspace(makeWorkspace({ openTabs: [tab], activeTab: tab, hydrateTabs }));
    await waitFor(() => expect(screen.queryByText(/Couldn't open/)).not.toBeInTheDocument());
  });

  it('shows a failed FIRST bootstrap even though it is reported under the default branch', async () => {
    // Nothing has asked for a branch yet, so the failure carries the default
    // branch's name while the URL names another. There is still no workspace,
    // so nothing can open until a bootstrap succeeds — say so.
    const git = makeGit({ status: null, availability: 'loading' });
    renderAt('/workspace/alice%2Fdraft/Knowledge/Foo.md', {
      git,
      workspace: makeWorkspace({
        workspaceId: null,
        bootstrapError: { branch: 'main', status: 0, message: 'Failed to fetch' },
      }),
    });

    expect(await screen.findByText(/Couldn't open main/)).toBeInTheDocument();
    expect(screen.getByText(/the request never completed/)).toBeInTheDocument();
    expect(screen.getByText('Failed to fetch')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('shows a failing git status refresh with a Retry rather than waiting on the next poll', async () => {
    // The refresh failed, so the last branch we know of is the one we were on
    // before, not the one the URL names. Reading now would read the wrong
    // branch's file; waiting silently is what produced the blank page.
    const refreshStatus = vi.fn(async () => null);
    const hydrateTabs = vi.fn<WorkspaceContextValue['hydrateTabs']>(async () => makeHydrateResult());
    const git = makeGit({
      status: makeStatus('alice/draft'),
      availability: 'error',
      lastError: 'branch-status: 503',
      refreshStatus,
    });

    const { rerenderGit, rerenderWorkspace } = renderAt('/workspace/main/Knowledge/Foo.md', {
      git,
      workspace: makeWorkspace({ hydrateTabs, workspaceBranch: 'alice/draft' }),
    });

    expect(
      await screen.findByText(/Couldn't check which branch this workspace is on/i),
    ).toBeInTheDocument();
    expect(screen.getByText('branch-status: 503')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await waitFor(() => expect(refreshStatus).toHaveBeenCalledTimes(1));
    // Still no read against a workspace whose branch is unconfirmed.
    expect(hydrateTabs).not.toHaveBeenCalled();

    // The retry succeeds: the status answers `main`, the workspace bootstraps
    // onto it, and the route does what it was holding off on — it reads. A
    // dead button or an error screen that never clears would stop right here,
    // which is what the assertions above alone could not tell apart.
    rerenderWorkspace(makeWorkspace({ hydrateTabs, workspaceBranch: 'main' }));
    rerenderGit(makeGit({ status: makeStatus('main'), availability: 'ready' }));
    await waitFor(() => expect(hydrateTabs).toHaveBeenCalled());
    expect(
      screen.queryByText(/Couldn't check which branch this workspace is on/i),
    ).not.toBeInTheDocument();
  });

  it('a failed status refresh on the branch we are ALREADY on is not an error screen', async () => {
    // Same availability, but the last known branch is the URL's branch: the
    // route knows which workspace it has and can read from it. A stale poll is
    // no reason to take the file off the screen.
    const hydrateTabs = vi.fn<WorkspaceContextValue['hydrateTabs']>(
      async () => makeHydrateResult({ surviving: ['Knowledge/Foo.md'] }),
    );
    const git = makeGit({
      status: makeStatus('alice/draft'),
      availability: 'error',
      lastError: 'branch-status: 503',
    });

    renderAt('/workspace/alice%2Fdraft/Knowledge/Foo.md', { git, workspace: makeWorkspace({ hydrateTabs }) });

    await waitFor(() => expect(hydrateTabs).toHaveBeenCalled());
    expect(
      screen.queryByText(/Couldn't check which branch this workspace is on/i),
    ).not.toBeInTheDocument();
  });

  it('names the file it is opening while the read is in flight, instead of the generic empty state', async () => {
    // The reported symptom: the URL names a file, the page says "Open a page
    // to start reading." and shows no tab strip, for as long as the read takes.
    const hydrateTabs = vi.fn<WorkspaceContextValue['hydrateTabs']>(
      () => new Promise(() => {}),
    );
    const git = makeGit({ status: makeStatus('alice/draft') });

    renderAt('/workspace/alice%2Fdraft/Knowledge/Foo.md', { git, workspace: makeWorkspace({ hydrateTabs }) });

    expect(await screen.findByText(/Opening Foo\.md/)).toBeInTheDocument();
    expect(screen.getByText('Knowledge/Foo.md')).toBeInTheDocument();
    expect(screen.queryByText(/Open a page to start reading/i)).not.toBeInTheDocument();
  });

  it('names the file while the workspace itself is still bootstrapping', async () => {
    const git = makeGit({ status: null, availability: 'loading' });

    renderAt('/workspace/alice%2Fdraft/Knowledge/Foo.md', {
      git,
      workspace: makeWorkspace({ workspaceId: null }),
    });

    expect(await screen.findByText(/Opening Foo\.md/)).toBeInTheDocument();
    expect(screen.queryByText(/Open a page to start reading/i)).not.toBeInTheDocument();
  });

  it('names the file it is opening even while the PREVIOUS file is still on screen', async () => {
    // Blankness is not the question. Clicking from one open file to another
    // leaves the old tab's content rendered for the whole read, so a
    // blank-only test called that "ready" and the page sat on the wrong file
    // with nothing to say a new one was coming.
    const addTab = vi.fn<WorkspaceContextValue['addTab']>(() => new Promise(() => {}));
    const hydrateTabs = vi.fn<WorkspaceContextValue['hydrateTabs']>(
      async () => makeHydrateResult({ surviving: ['Knowledge/Foo.md'] }),
    );
    const foo = makeTab({ path: 'Knowledge/Foo.md' });
    const git = makeGit({ status: makeStatus('alice/draft') });

    renderAt('/workspace/alice%2Fdraft/Knowledge/Foo.md', {
      git,
      workspace: makeWorkspace({ openTabs: [foo], activeTab: foo, hydrateTabs, addTab }),
    });
    await waitFor(() => expect(hydrateTabs).toHaveBeenCalled());
    expect(screen.queryByText(/Opening/)).not.toBeInTheDocument();

    // A click on another file on the same branch: its read never lands.
    fireEvent.click(screen.getByLabelText('click-baz'));
    expect(await screen.findByText(/Opening Baz\.md/)).toBeInTheDocument();
    expect(screen.getByText('Knowledge/Baz.md')).toBeInTheDocument();
  });

  it('does not flash a loading screen over the open file while its id URL resolves', async () => {
    // Canonicalising a path URL to the node's id URL passes through "the URL
    // names an id we have not resolved yet" with the file already on screen
    // and nothing in flight. Reading that as "not the target" would flash the
    // loading screen on every single file open.
    const PATH = 'Plugins/GTM/web-search.tool';
    routesMock.fetchNodeId.mockResolvedValue('web_search');
    let releaseResolve: ((path: string | null) => void) | undefined;
    routesMock.fetchNodeWorkspacePath.mockImplementation(
      () => new Promise((resolve) => { releaseResolve = resolve; }),
    );
    const tab = makeTab({ path: PATH });
    const hydrateTabs = vi.fn<WorkspaceContextValue['hydrateTabs']>(
      async () => makeHydrateResult({ surviving: [PATH] }),
    );

    renderAt(`/workspace/main/${PATH}`, {
      git: makeGit({ status: makeStatus('main') }),
      workspace: makeWorkspace({ openTabs: [tab], activeTab: tab, hydrateTabs }),
    });

    await waitFor(() =>
      expect(screen.getByLabelText('pathname')).toHaveTextContent('/workspace/main/web_search'),
    );
    await settle();
    // The id is still resolving — and the file it names is the one already up.
    expect(routesMock.fetchNodeWorkspacePath).toHaveBeenCalled();
    expect(screen.queryByText(/Opening/)).not.toBeInTheDocument();
    releaseResolve?.(PATH);
  });

  it('never reads from a workspace on another branch even when a RETAINED status says it matches', async () => {
    // `useGitState` keeps the previous branch when a refresh fails, so after
    // switching away and back the status can name the URL's branch while
    // `workspaceId` still serves the branch we switched to. The status alone
    // reads as a match; the workspace itself says otherwise, and it is the one
    // the read would go to.
    const hydrateTabs = vi.fn<WorkspaceContextValue['hydrateTabs']>(async () => makeHydrateResult());
    const addTab = vi.fn<WorkspaceContextValue['addTab']>(async () => true);
    const setPersistenceBranch = vi.fn();

    renderAt('/workspace/main/Knowledge/Foo.md', {
      git: makeGit({ status: makeStatus('main') }),
      workspace: makeWorkspace({
        hydrateTabs,
        addTab,
        setPersistenceBranch,
        workspaceBranch: 'alice/draft',
      }),
    });

    await settle();
    expect(hydrateTabs).not.toHaveBeenCalled();
    expect(addTab).not.toHaveBeenCalled();
    // It re-bootstraps onto the URL's branch instead, and says what it is doing.
    expect(setPersistenceBranch).toHaveBeenCalledWith('main');
    expect(screen.getByText(/Opening Foo\.md/)).toBeInTheDocument();
  });

  it('keeps the generic empty state for a URL that names no file', async () => {
    localStorage.clear();
    const hydrateTabs = vi.fn<WorkspaceContextValue['hydrateTabs']>(async () => makeHydrateResult());
    const git = makeGit({ status: makeStatus('alice/draft') });

    renderAt('/workspace/alice%2Fdraft', { git, workspace: makeWorkspace({ hydrateTabs }) });

    expect(await screen.findByText(/Open a page to start reading/i)).toBeInTheDocument();
    expect(screen.queryByText(/Opening/)).not.toBeInTheDocument();
  });

  it('reads nothing until the git status for the URL branch is known', async () => {
    // `gitStatusBranch=null` on every fresh browser session. The route used to
    // fall straight through and read the URL's path out of whatever workspace
    // the first bootstrap returned — a 404 for a file that exists, dropped.
    const hydrateTabs = vi.fn<WorkspaceContextValue['hydrateTabs']>(
      async () => makeHydrateResult({ surviving: ['Knowledge/Foo.md'] }),
    );
    const addTab = vi.fn<WorkspaceContextValue['addTab']>(async () => true);
    // The workspace knows its own branch the moment it exists (it is decoded
    // off the workspace id); it is the STATUS that hasn't answered yet, and
    // the status is what says the clone on disk is really on that branch.
    const workspace = makeWorkspace({ hydrateTabs, addTab, workspaceBranch: 'alice/draft' });
    const { rerenderGit } = renderAt('/workspace/alice%2Fdraft/Knowledge/Foo.md', {
      git: makeGit({ status: null, availability: 'loading' }),
      workspace,
    });

    await settle();
    expect(hydrateTabs).not.toHaveBeenCalled();
    expect(addTab).not.toHaveBeenCalled();
    expect(screen.getByText(/Opening Foo\.md/)).toBeInTheDocument();

    // Status answers with the URL's branch — now the read may run.
    rerenderGit(makeGit({ status: makeStatus('alice/draft') }));
    await waitFor(() => expect(hydrateTabs).toHaveBeenCalled());
  });

  it('never reads the URL path out of a workspace serving another branch', async () => {
    // Status says the workspace is on `alice/draft`; the URL is on `main`. The
    // only correct move is to re-bootstrap, never to read `main`'s path here.
    const hydrateTabs = vi.fn<WorkspaceContextValue['hydrateTabs']>(async () => makeHydrateResult());
    const addTab = vi.fn<WorkspaceContextValue['addTab']>(async () => true);
    const setPersistenceBranch = vi.fn();

    renderAt('/workspace/main/Knowledge/Foo.md', {
      git: makeGit({ status: makeStatus('alice/draft') }),
      workspace: makeWorkspace({ hydrateTabs, addTab, setPersistenceBranch }),
    });

    await waitFor(() => expect(setPersistenceBranch).toHaveBeenCalledWith('main'));
    await settle();
    expect(hydrateTabs).not.toHaveBeenCalled();
    expect(addTab).not.toHaveBeenCalled();
    // And it says what it is doing rather than showing the empty state.
    expect(screen.getByText(/Opening Foo\.md/)).toBeInTheDocument();
  });

  it('re-asserts the URL file through addTab even when it is ALREADY the open tab', async () => {
    // `addTab` on an open tab costs no read, and it is the only way to mark
    // this open as the latest — without it an older in-flight read still
    // counted as latest and activated its own file when it landed, leaving the
    // URL naming one file and the screen showing another.
    const tab = makeTab({ path: 'Knowledge/Foo.md' });
    const addTab = vi.fn<WorkspaceContextValue['addTab']>(async () => true);
    const workspace = makeWorkspace({
      openTabs: [tab],
      activeTab: tab,
      addTab,
      // Pretend hydration already ran for this (workspace, branch).
      hydrateTabs: vi.fn<WorkspaceContextValue['hydrateTabs']>(
        async () => makeHydrateResult({ surviving: ['Knowledge/Foo.md'] }),
      ),
    });

    renderAt('/workspace/alice%2Fdraft/Knowledge/Foo.md', {
      git: makeGit({ status: makeStatus('alice/draft') }),
      workspace,
      canonicalize: false,
    });

    await waitFor(() => expect(workspace.hydrateTabs).toHaveBeenCalled());

    // Click another file, then click straight back onto the one already open.
    fireEvent.click(screen.getByLabelText('click-baz'));
    await waitFor(() => expect(addTab).toHaveBeenCalledWith('Knowledge/Baz.md'));
    fireEvent.click(screen.getByLabelText('click-foo'));

    await waitFor(() => expect(addTab).toHaveBeenCalledWith('Knowledge/Foo.md'));
    // The LAST thing the route asked for is the file the URL names.
    expect(addTab.mock.calls.at(-1)?.[0]).toBe('Knowledge/Foo.md');
  });

  it('shows a 404 from a hydration whose branch matches the URL, rather than dropping it', async () => {
    const hydrateTabs = vi.fn<WorkspaceContextValue['hydrateTabs']>(
      async () => makeHydrateResult({ dropped: ['Knowledge/Gone.md'] }),
    );
    renderAt('/workspace/alice%2Fdraft/Knowledge/Gone.md', {
      git: makeGit({ status: makeStatus('alice/draft') }),
      workspace: makeWorkspace({ hydrateTabs }),
    });

    expect(await screen.findByText(/File not found/i)).toBeInTheDocument();
    expect(screen.queryByText(/Opening Gone\.md/)).not.toBeInTheDocument();
  });
});

/**
 * `?trace=files` — the reproduction diagnostics for a click that changes the
 * URL but leaves the page blank. They log which gate held the page and change
 * nothing about what it does.
 */
describe('FileRoute: ?trace=files diagnostics', () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function traceCalls(info: ReturnType<typeof vi.spyOn>) {
    return info.mock.calls
      .filter((c: unknown[]) => c[0] === '[trace:files]')
      .map((c: unknown[]) => ({ event: c[1] as string, fields: c[2] as Record<string, unknown> }));
  }

  it('logs the wait on a git status branch that differs from the URL, with the four reproduction fields', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const setPersistenceBranch = vi.fn();
    const hydrateTabs = vi.fn<WorkspaceContextValue['hydrateTabs']>(async () => makeHydrateResult());
    const workspace = makeWorkspace({
      hydrateTabs,
      setPersistenceBranch,
      bootstrapError: { branch: 'main', status: 500, message: 'Internal Server Error' },
      openTabs: [makeTab({ path: 'Knowledge/Old.md' })],
    });
    const git = makeGit({ status: makeStatus('alice/draft') });

    renderAt('/workspace/main/Knowledge/Foo.md?trace=files', { git, workspace });

    await waitFor(() => expect(setPersistenceBranch).toHaveBeenCalledWith('main'));
    const wait = traceCalls(info).find((c) => c.event === 'wait:branch-mismatch');
    expect(wait?.fields).toMatchObject({
      url: '/workspace/main/Knowledge/Foo.md',
      branchFromUrl: 'main',
      pathFromUrl: 'Knowledge/Foo.md',
      gitStatusBranch: 'alice/draft',
      bootstrapError: { branch: 'main', status: 500, message: 'Internal Server Error' },
      openTabs: ['Knowledge/Old.md'],
    });
    // Still no read against a workspace on the wrong branch — but the page now
    // says so rather than sitting on the empty state (see the bootstrap-failure
    // screen tests above).
    expect(hydrateTabs).not.toHaveBeenCalled();
  });

  it('numbers each hydration so a start and its settle can be paired in the console', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const hydrateTabs = vi.fn<WorkspaceContextValue['hydrateTabs']>(
      async () => makeHydrateResult({ surviving: ['Knowledge/Foo.md'] }),
    );
    const workspace = makeWorkspace({ hydrateTabs });
    const git = makeGit({ status: makeStatus('alice/draft') });

    renderAt('/workspace/alice%2Fdraft/Knowledge/Foo.md?trace=files', { git, workspace });

    await waitFor(() => {
      expect(traceCalls(info).some((c) => c.event === 'hydrate:settled')).toBe(true);
    });
    const calls = traceCalls(info);
    const start = calls.find((c) => c.event === 'hydrate:start');
    const settled = calls.find((c) => c.event === 'hydrate:settled');
    expect(start?.fields).toMatchObject({ paths: ['Knowledge/Foo.md'], activePath: 'Knowledge/Foo.md' });
    expect(settled?.fields).toMatchObject({
      surviving: ['Knowledge/Foo.md'],
      cancelled: false,
      // What the hydration left open, not this render's pre-hydration tabs.
      openTabs: ['Knowledge/Foo.md'],
      openFilePath: 'Knowledge/Foo.md',
    });
    expect(settled?.fields.hydrateSeq).toBe(start?.fields.hydrateSeq);
  });

  it('logs the failed status of a hydration before the error screen it already had', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const hydrateTabs = vi.fn(async () => {
      throw new WorkspaceApiError(500);
    });
    const workspace = makeWorkspace({ hydrateTabs });
    const git = makeGit({ status: makeStatus('alice/draft') });

    renderAt('/workspace/alice%2Fdraft/Knowledge/Foo.md?trace=files', { git, workspace });

    await waitFor(() => expect(screen.getByText(/Couldn't load this file/i)).toBeInTheDocument());
    expect(traceCalls(info).find((c) => c.event === 'hydrate:failed')?.fields).toMatchObject({
      status: 500,
      cancelled: false,
    });
  });

  it('logs a bootstrap failure that arrives while the page waits for its workspace', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const git = makeGit({ status: null });
    const { rerenderWorkspace } = renderAt('/workspace/main/Knowledge/Foo.md?trace=files', {
      git,
      workspace: makeWorkspace({ workspaceId: null }),
    });

    await waitFor(() => {
      expect(traceCalls(info).some((c) => c.event === 'wait:no-workspace')).toBe(true);
    });
    rerenderWorkspace(makeWorkspace({ workspaceId: null, bootstrapError: { branch: 'main', status: 500, message: 'Internal Server Error' } }));

    await waitFor(() => {
      const waits = traceCalls(info).filter((c) => c.event === 'wait:no-workspace');
      expect(waits.at(-1)?.fields).toMatchObject({ bootstrapError: { branch: 'main', status: 500, message: 'Internal Server Error' } });
    });

    // A file click while the workspace is still missing logs the new URL.
    fireEvent.click(screen.getByLabelText('tree-click-bar'));
    await waitFor(() => {
      const waits = traceCalls(info).filter((c) => c.event === 'wait:no-workspace');
      expect(waits.at(-1)?.fields).toMatchObject({
        url: '/workspace/main/Knowledge/Bar.md',
        pathFromUrl: 'Knowledge/Bar.md',
      });
    });
  });

  it('logs the wait for a git status that has not answered yet', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const hydrateTabs = vi.fn<WorkspaceContextValue['hydrateTabs']>(async () => makeHydrateResult());
    renderAt('/workspace/alice%2Fdraft/Knowledge/Foo.md?trace=files', {
      git: makeGit({ status: null, availability: 'loading' }),
      workspace: makeWorkspace({ hydrateTabs }),
    });

    await waitFor(() =>
      expect(traceCalls(info).some((c) => c.event === 'wait:git-status')).toBe(true),
    );
    expect(traceCalls(info).find((c) => c.event === 'wait:git-status')?.fields).toMatchObject({
      branchFromUrl: 'alice/draft',
      pathFromUrl: 'Knowledge/Foo.md',
      gitStatusBranch: null,
    });
    expect(hydrateTabs).not.toHaveBeenCalled();
  });

  it('names the screen that won, so the console says what the reader is looking at', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    renderAt('/workspace/alice%2Fdraft/Knowledge/Foo.md?trace=files', {
      git: makeGit({ status: makeStatus('alice/draft') }),
      workspace: makeWorkspace({
        bootstrapError: { branch: 'alice/draft', status: 500, message: 'HTTP 500' },
      }),
    });

    await waitFor(() =>
      expect(traceCalls(info).some((c) => c.event === 'screen')).toBe(true),
    );
    expect(traceCalls(info).filter((c) => c.event === 'screen').at(-1)?.fields)
      .toMatchObject({ screen: 'bootstrap-failed' });
  });

  it('logs the loading screen, naming the file it is waiting on', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    renderAt('/workspace/alice%2Fdraft/Knowledge/Foo.md?trace=files', {
      git: makeGit({ status: makeStatus('alice/draft') }),
      workspace: makeWorkspace({
        hydrateTabs: vi.fn<WorkspaceContextValue['hydrateTabs']>(() => new Promise(() => {})),
      }),
    });

    await waitFor(() => {
      const last = traceCalls(info).filter((c) => c.event === 'screen').at(-1);
      expect(last?.fields).toMatchObject({ screen: 'loading', loadingFile: 'Knowledge/Foo.md' });
    });
  });

  it('logs the re-assertion of a file that is already open', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const tab = makeTab({ path: 'Knowledge/Foo.md' });
    const addTab = vi.fn<WorkspaceContextValue['addTab']>(async () => true);
    const workspace = makeWorkspace({
      openTabs: [tab],
      activeTab: tab,
      addTab,
      hydrateTabs: vi.fn<WorkspaceContextValue['hydrateTabs']>(
        async () => makeHydrateResult({ surviving: ['Knowledge/Foo.md'] }),
      ),
    });
    renderAt('/workspace/alice%2Fdraft/Knowledge/Foo.md?trace=files', {
      git: makeGit({ status: makeStatus('alice/draft') }),
      workspace,
      canonicalize: false,
    });

    await waitFor(() => expect(workspace.hydrateTabs).toHaveBeenCalled());
    fireEvent.click(screen.getByLabelText('click-baz'));
    await waitFor(() => expect(addTab).toHaveBeenCalledWith('Knowledge/Baz.md'));
    fireEvent.click(screen.getByLabelText('click-foo'));

    await waitFor(() =>
      expect(traceCalls(info).some((c) => c.event === 'add-tab:already-open')).toBe(true),
    );
  });

  it('logs nothing without the flag', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const hydrateTabs = vi.fn<WorkspaceContextValue['hydrateTabs']>(
      async () => makeHydrateResult({ surviving: ['Knowledge/Foo.md'] }),
    );
    const workspace = makeWorkspace({ hydrateTabs });
    const git = makeGit({ status: makeStatus('alice/draft') });

    renderAt('/workspace/alice%2Fdraft/Knowledge/Foo.md', { git, workspace });

    await waitFor(() => expect(hydrateTabs).toHaveBeenCalled());
    expect(traceCalls(info)).toHaveLength(0);
  });
});
