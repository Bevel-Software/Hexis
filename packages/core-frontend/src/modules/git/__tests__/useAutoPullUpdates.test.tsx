import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { BranchInfo, CommitAttribution, FileTreeEntry, WorkingTreeStatus } from '@bevel-software/platform-shared';
import { useAutoPullUpdates } from '../hooks/useAutoPullUpdates';
import type { GitContextValue } from '../state/git.context';
import type { WorkspaceContextValue } from '../../workspace/state/workspace.context';
import { makeWorkspaceFixture } from '../../workspace/__tests__/testFixtures';

function makeStatus(overrides: Partial<WorkingTreeStatus> = {}): WorkingTreeStatus {
  return {
    branch: 'current-company-state',
    hasUpstream: true,
    unmergedFromUpstream: true,
    ...overrides,
  };
}

function makeTree(paths: string[] = ['Knowledge/Foo.md']): FileTreeEntry {
  return {
    name: '',
    relativePath: '',
    type: 'directory',
    children: paths.map((p) => ({
      name: p.split('/').pop() ?? p,
      relativePath: p,
      type: 'file' as const,
    })),
  };
}

function makeGit(
  overrides: Partial<GitContextValue> & { status?: WorkingTreeStatus | null } = {},
): GitContextValue {
  const status: WorkingTreeStatus | null =
    overrides.status === undefined ? makeStatus() : overrides.status;
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
    revert: async (): Promise<CommitAttribution> => ({
      authorName: '',
      authorEmail: '',
      sha: '',
      subject: '',
      committedAt: '',
    }),
    fetchFileHistory: async () => [],
    fetchFileDiff: async () => '',
    fetchFileAtChange: async () => ({ baseline: null, current: null }),
    fetchFileComparison: async () => '',
    ...overrides,
  };
}

interface WorkspaceFixture extends WorkspaceContextValue {
  refreshFileTree: ReturnType<typeof vi.fn>;
  bumpFsRevision: ReturnType<typeof vi.fn>;
}

function makeWorkspace(
  overrides: Partial<WorkspaceContextValue> & {
    refreshFileTreeResult?: FileTreeEntry | null;
  } = {},
): WorkspaceFixture {
  const refreshFileTree = vi.fn(
    async (): Promise<FileTreeEntry | null> =>
      overrides.refreshFileTreeResult === undefined
        ? makeTree()
        : overrides.refreshFileTreeResult,
  );
  const bumpFsRevision = vi.fn(() => {});
  return makeWorkspaceFixture({
    ...overrides,
    refreshFileTree,
    bumpFsRevision,
  }) as WorkspaceFixture;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useAutoPullUpdates', () => {
  it('pulls clean protected branches automatically and bumps fsRevision after refresh', async () => {
    // Under the multi-tab model the hook signals open tabs to re-read disk
    // via `bumpFsRevision()` instead of the legacy single-file openFile /
    // closeFile dance. Active tab refetches eagerly; any tab whose file
    // vanished gets dropped by the eager refetch's 404 handler in
    // useWorkspaceState (covered by its own tests).
    const pull = vi.fn(async () => {});
    const workspace = makeWorkspace({
      refreshFileTreeResult: makeTree(['Knowledge/Foo.md', 'Knowledge/New.md']),
    });
    const git = makeGit({ status: makeStatus({ branch: 'current-company-state' }), pull });
    const onPrStale = vi.fn();
    window.addEventListener('bevel:pr-stale', onPrStale);

    renderHook(() => useAutoPullUpdates(git, workspace));

    await waitFor(() => expect(pull).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(workspace.refreshFileTree).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(workspace.bumpFsRevision).toHaveBeenCalledTimes(1));
    expect(onPrStale).toHaveBeenCalledTimes(1);

    window.removeEventListener('bevel:pr-stale', onPrStale);
  });

  it('exposes updating state while the automatic pull is in flight', async () => {
    let resolvePull: () => void = () => {};
    const pull = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolvePull = resolve;
        }),
    );

    const workspace = makeWorkspace();
    const git = makeGit({ status: makeStatus({ branch: 'current-company-state' }), pull });
    const { result } = renderHook(() => useAutoPullUpdates(git, workspace));

    await waitFor(() => expect(result.current).toMatchObject({
      status: 'updating',
      branch: 'current-company-state',
      reason: null,
    }));

    resolvePull();
    await waitFor(() => expect(result.current.status).toBe('idle'));
  });

  it('exposes failed state with sanitized reason when automatic pull fails', async () => {
    const pull = vi.fn(async () => {
      throw new Error(
        'fatal: could not resolve host https://ghp_supersecrettoken1234567890abcdef@example.com/org/repo in /Users/alice/work/bevel token=ghp_supersecrettoken1234567890abcdef',
      );
    });

    const workspace = makeWorkspace();
    const git = makeGit({ status: makeStatus({ branch: 'current-company-state' }), pull });
    const { result } = renderHook(() => useAutoPullUpdates(git, workspace));

    await waitFor(() => expect(result.current.status).toBe('failed'));
    expect(result.current.branch).toBe('current-company-state');
    expect(result.current.reason).toContain('[url]');
    expect(result.current.reason).not.toContain('https://');
    expect(result.current.reason).not.toContain('/Users/alice/work/bevel');
    expect(result.current.reason).not.toContain('ghp_supersecrettoken');
  });

  it('resets state after the branch is no longer behind', async () => {
    const pull = vi.fn(async () => {
      throw new Error('boom');
    });
    const workspace = makeWorkspace();

    const { result, rerender } = renderHook(
      ({ status }: { status: WorkingTreeStatus }) =>
        useAutoPullUpdates(makeGit({ status, pull }), workspace),
      { initialProps: { status: makeStatus({ branch: 'current-company-state' }) } },
    );

    await waitFor(() => expect(result.current.status).toBe('failed'));

    rerender({
      status: makeStatus({
        branch: 'current-company-state',
        unmergedFromUpstream: false,
      }),
    });

    await waitFor(() => expect(result.current.status).toBe('idle'));
  });

  it('auto-pulls feature branches that are behind upstream', async () => {
    // Under save=share, the on-disk clone is shared across all users on
    // a given branch (feature OR protected). A feature branch silently
    // falling behind upstream causes non-fast-forward push failures on
    // the next save, surfacing as confusing "draft is missing teammate
    // updates" banners. The hook must auto-pull these too.
    const pull = vi.fn(async () => {});

    renderHook(() =>
      useAutoPullUpdates(
        makeGit({ status: makeStatus({ branch: 'alice/draft' }), pull }),
        makeWorkspace(),
      ),
    );

    await waitFor(() => expect(pull).toHaveBeenCalledTimes(1));
  });

  it('does not auto-pull while the open editor has unsaved in-memory changes', async () => {
    const pull = vi.fn(async () => {});

    renderHook(() =>
      useAutoPullUpdates(
        makeGit({ status: makeStatus(), pull }),
        makeWorkspace({ hasUnsavedFileChanges: true }),
      ),
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pull).not.toHaveBeenCalled();
  });
});
