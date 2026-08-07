import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { BranchInfo, FileTreeEntry, WorkingTreeStatus } from '@bevel-software/platform-shared';
import { PullNeededBanner } from '../components/PullNeededBanner';
import { GitContext, type GitContextValue } from '../state/git.context';
import {
  AutoUpdateContext,
  IDLE_AUTO_UPDATE,
  type AutoUpdateState,
} from '../state/auto-update.context';
// The banner doesn't seed chat directly — it calls the change-request port
// (`resolvePullIssue`). In the enterprise build a registry provider binds that
// port to chat seeding; core tests mount a stub port and assert the port
// itself is invoked with the classified, user-safe payload.
import { CrCreationPortContext, type CrCreationPort } from '../../../core/registry';
import {
  WorkspaceContext,
  type WorkspaceContextValue,
} from '../../workspace/state/workspace.context';
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

function renderWith(
  git: GitContextValue,
  options: {
    autoUpdate?: AutoUpdateState;
    resolvePullIssue?: ReturnType<typeof vi.fn>;
    workspace?: WorkspaceFixture;
  } = {},
) {
  const resolvePullIssue = options.resolvePullIssue ?? vi.fn();
  const port: CrCreationPort = { start: vi.fn(), resolvePullIssue };
  const workspace = options.workspace ?? makeWorkspace();
  const autoUpdate = options.autoUpdate ?? IDLE_AUTO_UPDATE;
  const result = render(
    <WorkspaceContext.Provider value={workspace}>
      <GitContext.Provider value={git}>
        <AutoUpdateContext.Provider value={autoUpdate}>
          <CrCreationPortContext.Provider value={port}>
            <PullNeededBanner />
          </CrCreationPortContext.Provider>
        </AutoUpdateContext.Provider>
      </GitContext.Provider>
    </WorkspaceContext.Provider>,
  );
  return { ...result, workspace, resolvePullIssue };
}

function failedAutoUpdate(branch = 'current-company-state'): AutoUpdateState {
  return { status: 'failed', branch, reason: 'Network unreachable' };
}

// Wrap addEventListener so callers can register the listener inline and
// guarantee removal via the returned cleanup, even if the test body throws
// before the manual removeEventListener line is reached.
function attachPrStaleListener(handler: EventListener): () => void {
  window.addEventListener('bevel:pr-stale', handler);
  return () => window.removeEventListener('bevel:pr-stale', handler);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PullNeededBanner: gating', () => {
  it('renders nothing when availability is not ready', () => {
    const { container } = renderWith(makeGit({ availability: 'loading', status: null }));
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when unmergedFromUpstream is false', () => {
    const { container } = renderWith(
      makeGit({ status: makeStatus({ unmergedFromUpstream: false }) }),
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing for clean protected branches because auto-update owns them', () => {
    const { container } = renderWith(
      makeGit({ status: makeStatus({ branch: 'current-company-state' }) }),
    );
    expect(container.firstChild).toBeNull();
  });

  it('shows failed auto-update state with Retry', () => {
    renderWith(makeGit({ status: makeStatus({ branch: 'current-company-state' }) }), {
      autoUpdate: failedAutoUpdate(),
    });

    expect(screen.getByText(/Couldn’t update automatically/)).toBeInTheDocument();
    expect(screen.getByText('Network unreachable')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled();
  });

  // Removed: "shows passive guidance for dirty protected branches without a
  // button" — the dirty-tree case is structurally impossible under save=share
  // (every write auto-commits on lock release), so the status no longer
  // carries an `isDirty` field and the banner no longer emits the
  // "discard your local changes" fallback. The "unsaved editor changes"
  // case below remains because in-memory tab edits ARE still a real signal.

  it('shows passive guidance for unsaved editor changes without a button', () => {
    renderWith(makeGit({ status: makeStatus({ branch: 'current-company-state' }) }), {
      workspace: makeWorkspace({ hasUnsavedFileChanges: true }),
    });

    expect(screen.getByText(/Updates are waiting/)).toBeInTheDocument();
    expect(screen.getByText(/Finish or save your open file/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('PullNeededBanner: protected branch (auto-update failed retry)', () => {
  it('calls git.pull() and does NOT invoke the change-request port on retry', async () => {
    const pull = vi.fn(async () => {});
    const { resolvePullIssue } = renderWith(
      makeGit({ status: makeStatus({ branch: 'current-company-state' }), pull }),
      { autoUpdate: failedAutoUpdate() },
    );

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(pull).toHaveBeenCalledTimes(1));
    expect(resolvePullIssue).not.toHaveBeenCalled();
  });

  it('also retries direct pull on target-company-state after auto-update fails', async () => {
    const pull = vi.fn(async () => {});
    renderWith(makeGit({ status: makeStatus({ branch: 'target-company-state' }), pull }), {
      autoUpdate: failedAutoUpdate('target-company-state'),
    });

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(pull).toHaveBeenCalledTimes(1));
  });

  it('shows the Retrying… label and disables the button while retry is in flight', async () => {
    let resolvePull: () => void = () => {};
    const pull = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolvePull = resolve;
        }),
    );
    renderWith(makeGit({ status: makeStatus({ branch: 'current-company-state' }), pull }), {
      autoUpdate: failedAutoUpdate(),
    });

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Retrying…' })).toBeDisabled(),
    );

    resolvePull();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled(),
    );
  });

  it('surfaces the error message inline when pull fails, banner stays visible', async () => {
    const pull = vi.fn(async () => {
      throw new Error('Network unreachable');
    });
    renderWith(makeGit({ status: makeStatus({ branch: 'current-company-state' }), pull }), {
      autoUpdate: failedAutoUpdate(),
    });

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Network unreachable'),
    );
    expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled();
  });

  it('falls back to handing the failure to the change-request port when direct pull fails', async () => {
    const pull = vi.fn(async () => {
      throw new Error('working tree has uncommitted changes');
    });
    const resolvePullIssue = vi.fn();
    renderWith(
      makeGit({ status: makeStatus({ branch: 'current-company-state' }), pull }),
      { autoUpdate: failedAutoUpdate(), resolvePullIssue },
    );

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(resolvePullIssue).toHaveBeenCalledTimes(1));
    // The classified reason handed to the port must NOT leak git vocabulary
    // (no "uncommitted", "working tree", "merge conflict", "stash", "HEAD") —
    // registries render it to the user verbatim. We assert the user-facing
    // phrase the classifier produces for a dirty-tree-shaped error AND that
    // the raw git terms aren't in the payload.
    expect(resolvePullIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        branch: 'current-company-state',
        kind: 'pull-failed',
        reason: expect.stringContaining('local changes that need to be sorted out'),
      }),
    );
    const seededText = (resolvePullIssue.mock.calls[0]?.[0] as { reason?: string })?.reason ?? '';
    expect(seededText).not.toMatch(/uncommitted|working tree|stash|HEAD|merge conflict/i);
  });

  it('hands off only a classified pull-failure reason without sensitive error details', async () => {
    const pull = vi.fn(async () => {
      throw new Error(
        'fatal: could not resolve host https://ghp_supersecrettoken1234567890abcdef@example.com/org/repo in /Users/alice/work/bevel token=ghp_supersecrettoken1234567890abcdef',
      );
    });
    const resolvePullIssue = vi.fn();
    renderWith(
      makeGit({ status: makeStatus({ branch: 'current-company-state' }), pull }),
      { autoUpdate: failedAutoUpdate(), resolvePullIssue },
    );

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(resolvePullIssue).toHaveBeenCalledTimes(1));
    const reason = (resolvePullIssue.mock.calls[0][0] as { reason: string }).reason;
    // Plain-language phrase the classifier returns for network/auth-shaped
    // errors. No git vocabulary (no "401", "credential", "fatal", etc.) and
    // none of the sensitive details from the underlying error message.
    expect(reason).toContain('connection or permission problem');
    expect(reason).not.toContain('https://');
    expect(reason).not.toContain('/Users/alice/work/bevel');
    expect(reason).not.toContain('ghp_supersecrettoken');
  });

  it('shows a generic message when the thrown value is not an Error', async () => {
    const pull = vi.fn(async () => {
      throw 'oops';
    });
    renderWith(makeGit({ status: makeStatus({ branch: 'current-company-state' }), pull }), {
      autoUpdate: failedAutoUpdate(),
    });

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/Could not get updates/),
    );
  });

  it('clears a stale error when the user retries successfully', async () => {
    let shouldFail = true;
    const pull = vi.fn(async () => {
      if (shouldFail) throw new Error('boom');
    });
    renderWith(makeGit({ status: makeStatus({ branch: 'current-company-state' }), pull }), {
      autoUpdate: failedAutoUpdate(),
    });

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());

    shouldFail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(pull).toHaveBeenCalledTimes(2);
  });
});

describe('PullNeededBanner: workspace refresh after successful pull', () => {
  // Under the multi-tab model, the post-pull reconciliation moved from a
  // single-file openFile/closeFile shuffle to a `bumpFsRevision()` call:
  // the active tab eagerly refetches, inactive non-dirty tabs invalidate,
  // and tabs whose files vanished get dropped by the eager refetch's 404
  // handler in useWorkspaceState. Tests assert the new signal, not the
  // legacy single-file moves.

  it('refreshes the file tree and bumps fsRevision after a successful pull', async () => {
    const pull = vi.fn(async () => {});
    const workspace = makeWorkspace({
      refreshFileTreeResult: makeTree(['Knowledge/Foo.md', 'Knowledge/New.md']),
    });
    renderWith(makeGit({ status: makeStatus({ branch: 'current-company-state' }), pull }), {
      autoUpdate: failedAutoUpdate(),
      workspace,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(workspace.refreshFileTree).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(workspace.bumpFsRevision).toHaveBeenCalledTimes(1));
  });

  it('dispatches bevel:pr-stale exactly once per successful pull', async () => {
    const pull = vi.fn(async () => {});
    const onPrStale = vi.fn();
    const detachPrStale = attachPrStaleListener(onPrStale);
    try {
      renderWith(makeGit({ status: makeStatus({ branch: 'current-company-state' }), pull }), {
        autoUpdate: failedAutoUpdate(),
      });

      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

      await waitFor(() => expect(onPrStale).toHaveBeenCalledTimes(1));
    } finally {
      detachPrStale();
    }
  });

  it('does NOT refresh workspace or fire pr-stale when pull fails', async () => {
    const pull = vi.fn(async () => {
      throw new Error('boom');
    });
    const workspace = makeWorkspace();
    const onPrStale = vi.fn();
    const detachPrStale = attachPrStaleListener(onPrStale);
    try {
      renderWith(makeGit({ status: makeStatus({ branch: 'current-company-state' }), pull }), {
        autoUpdate: failedAutoUpdate(),
        workspace,
      });

      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

      await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
      expect(workspace.refreshFileTree).not.toHaveBeenCalled();
      expect(workspace.bumpFsRevision).not.toHaveBeenCalled();
      expect(onPrStale).not.toHaveBeenCalled();
    } finally {
      detachPrStale();
    }
  });
});

describe('PullNeededBanner: feature branch (agent flow, REGRESSION)', () => {
  // CRITICAL: feature-branch behavior must remain the port hand-off flow.
  // Conflicts can happen when the user has local commits, and an interactive
  // resolution (the enterprise agent) earns its keep there. Direct pull on
  // feature branches would surface a raw rebase error with no path forward.

  it('hands the behind-state to the port and does NOT call git.pull() or refresh the workspace', () => {
    const pull = vi.fn(async () => {});
    const workspace = makeWorkspace();
    const onPrStale = vi.fn();
    const detachPrStale = attachPrStaleListener(onPrStale);
    try {
      const { resolvePullIssue } = renderWith(
        makeGit({ status: makeStatus({ branch: 'alice/draft' }), pull }),
        { workspace },
      );

      fireEvent.click(screen.getByRole('button', { name: 'Ask assistant' }));

      expect(pull).not.toHaveBeenCalled();
      expect(workspace.refreshFileTree).not.toHaveBeenCalled();
      expect(workspace.bumpFsRevision).not.toHaveBeenCalled();
      expect(onPrStale).not.toHaveBeenCalled();
      expect(resolvePullIssue).toHaveBeenCalledTimes(1);
      expect(resolvePullIssue).toHaveBeenCalledWith(
        expect.objectContaining({ branch: 'alice/draft', kind: 'behind' }),
      );
    } finally {
      detachPrStale();
    }
  });

  it('invokes the port for any non-protected branch name', () => {
    const { resolvePullIssue } = renderWith(makeGit({ status: makeStatus({ branch: 'main' }) }));

    fireEvent.click(screen.getByRole('button', { name: 'Ask assistant' }));

    expect(resolvePullIssue).toHaveBeenCalledTimes(1);
  });
});
