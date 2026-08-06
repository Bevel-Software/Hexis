import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { ReactNode } from 'react';
import type { WorkingTreeStatus } from '@bevel-software/platform-shared';
import { FileRoute } from '../FileRoute';
import { WorkspaceApiError } from '../../services/workspace.api';
import { GitContext, type GitContextValue } from '../../../git/state/git.context';
import { WorkspaceContext, type WorkspaceContextValue, type OpenTab } from '../../state/workspace.context';
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
    revert: async () => ({ sha: 'a', authorName: 'n', authorEmail: 'e', subject: 's', committedAt: '2026-04-20T00:00:00.000Z' }),
    fetchFileHistory: async () => [],
    fetchFileDiff: async () => '',
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
function makeHydrateResult(
  overrides: Partial<{ surviving: string[]; dropped: string[]; denied: string[] }> = {},
): { surviving: string[]; dropped: string[]; denied: string[] } {
  return { surviving: [], dropped: [], denied: [], ...overrides };
}

function renderAt(
  url: string,
  opts: { git?: GitContextValue; workspace?: WorkspaceContextValue } = {},
): { workspace: WorkspaceContextValue; git: GitContextValue } {
  const workspace = opts.workspace ?? makeWorkspace();
  const git = opts.git ?? makeGit();
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

  render(
    <MemoryRouter initialEntries={[url]}>
      <Tree>
        <Routes>
          <Route path="/workspace/:branch/*" element={<FileRoute />} />
        </Routes>
      </Tree>
    </MemoryRouter>,
  );

  return { workspace, git };
}

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
