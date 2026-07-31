import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import type { BranchInfo, CommitAttribution, WorkingTreeStatus } from '@bevel-software/shared';

// Mock the access API before importing the component tree — useFileAccess
// fires a fetch in an effect on mount, and we don't want real network in tests.
const accessMock = vi.hoisted(() => ({
  result: { canWrite: true, eligible: { roles: ['Admin'], users: [] } } as {
    canWrite: boolean;
    eligible: { roles: string[]; users: { name: string; email: string }[] };
  },
}));
vi.mock('../../access/api', () => ({
  fetchFileAccess: vi.fn(async () => accessMock.result),
  fetchFileAccessBatch: vi.fn(async () => ({ results: {} })),
}));

import { FileHistoryPanel } from '../components/FileHistoryPanel';
import { GitContext, type GitContextValue } from '../state/git.context';
import {
  WorkspaceContext,
  type WorkspaceContextValue,
} from '../../workspace/state/workspace.context';

function makeAttr(partial: Partial<CommitAttribution> = {}): CommitAttribution {
  return {
    sha: 'abcdef1234567890',
    authorName: 'Alice',
    authorEmail: 'alice@example.com',
    subject: 'edit file',
    committedAt: '2026-04-17T10:00:00Z',
    ...partial,
  };
}

function makeGit(overrides: Partial<GitContextValue> = {}): GitContextValue {
  const status: WorkingTreeStatus = {
    branch: 'alice/foo',
    hasUpstream: true,
    unmergedFromUpstream: false,
  };
  const branches: BranchInfo[] = [];
  return {
    status,
    branches,
    availability: 'ready',
    lastError: null,
    refreshStatus: async () => null,
    refreshBranches: async () => {},
    createBranch: async () => {},
    pull: async () => {},
    deleteBranch: async () => {},
    fetchForkBase: async () => null,
    revert: async () => makeAttr({ sha: 'revertsha1234567' }),
    fetchFileHistory: async () => [],
    fetchFileDiff: async () => '',
    fetchFileComparison: async () => '',
    ...overrides,
  };
}

const workspace = {
  workspaceId: 'ws-1',
  kbDirName: 'knowledge-base',
} as unknown as WorkspaceContextValue;

function renderWith(git: GitContextValue, onRevert: () => Promise<void> = async () => {}) {
  return render(
    <WorkspaceContext.Provider value={workspace}>
      <GitContext.Provider value={git}>
        <FileHistoryPanel
          filePath="knowledge-base/Knowledge/Foo.md"
          onRevertCompleted={onRevert}
        />
      </GitContext.Provider>
    </WorkspaceContext.Provider>,
  );
}

describe('FileHistoryPanel', () => {
  it('renders the timeline returned from fetchFileHistory', async () => {
    const history = [
      makeAttr({ sha: 'aaaaaaa0000000000', subject: 'first' }),
      makeAttr({ sha: 'bbbbbbb0000000000', subject: 'second', authorName: 'Bob' }),
    ];
    renderWith(makeGit({ fetchFileHistory: async () => history }));
    expect(await screen.findByText('first')).toBeInTheDocument();
    expect(screen.getByText('second')).toBeInTheDocument();
    // Author is rendered alongside a relative timestamp in a single line, e.g. "Bob · 2w ago".
    expect(screen.getByText(/Bob\s*·/)).toBeInTheDocument();
  });

  it('shows an empty state when the file has no saves', async () => {
    renderWith(makeGit({ fetchFileHistory: async () => [] }));
    expect(await screen.findByText(/Nothing has been saved to this file/i)).toBeInTheDocument();
  });

  it('loads the diff when a commit is selected', async () => {
    const fetchFileDiff = vi.fn(async () => '--- a\n+++ b\n@@ -1 +1 @@\n-foo\n+bar\n');
    const history = [makeAttr({ sha: 'aaaaaaa0000000000', subject: 'edit' })];
    renderWith(
      makeGit({
        fetchFileHistory: async () => history,
        fetchFileDiff,
      }),
    );
    const row = await screen.findByText('edit');
    fireEvent.click(row);
    await waitFor(() =>
      expect(fetchFileDiff).toHaveBeenCalledWith(
        'knowledge-base/Knowledge/Foo.md',
        'aaaaaaa0000000000',
      ),
    );
    expect(await screen.findByText(/\+bar/)).toBeInTheDocument();
  });

  it('renders "No file changes in this save" when the selected diff is empty', async () => {
    const history = [makeAttr({ sha: 'aaaaaaa0000000000', subject: 'edit' })];
    renderWith(
      makeGit({
        fetchFileHistory: async () => history,
        fetchFileDiff: async () => '',
      }),
    );
    fireEvent.click(await screen.findByText('edit'));
    expect(await screen.findByText(/No file changes in this save/i)).toBeInTheDocument();
  });

  it('calls revert and fires onRevertCompleted on success', async () => {
    const onRevert = vi.fn();
    const revert = vi.fn(async () => makeAttr({ sha: 'reverteddeadbeef' }));
    const history = [makeAttr({ sha: 'aaaaaaa0000000000', subject: 'edit' })];
    renderWith(
      makeGit({
        fetchFileHistory: async () => history,
        revert,
      }),
      onRevert,
    );
    fireEvent.click(await screen.findByText('edit'));
    const undoButton = await screen.findByRole('button', { name: /Undo this save/i });
    fireEvent.click(undoButton);
    await waitFor(() => expect(revert).toHaveBeenCalledWith('aaaaaaa0000000000'));
    await waitFor(() => expect(onRevert).toHaveBeenCalled());
  });

  it.each(['current-company-state', 'target-company-state'] as const)(
    'enables the undo button on protected branch %s when the user has write access',
    async (branch) => {
      // The historical gate was "protected branch → disabled." Revert is now
      // gated by per-path write access (canWrite) instead — admins on a
      // canonical branch can undo directly.
      const history = [makeAttr({ sha: 'aaaaaaa0000000000', subject: 'edit' })];
      renderWith(
        makeGit({
          status: {
            branch,
            hasUpstream: true,
            unmergedFromUpstream: false,
          },
          fetchFileHistory: async () => history,
        }),
      );
      fireEvent.click(await screen.findByText('edit'));
      const undoButton = await screen.findByRole('button', { name: /Undo this save/i });
      await waitFor(() => expect(undoButton).not.toBeDisabled());
    },
  );

  it('disables the undo button when the user lacks write access on a protected branch', async () => {
    // The revert gate is only consulted on protected branches — drafts are
    // free-for-all (the backend's revertCommit skips the access check on
    // non-protected branches, so the editor mirrors that by leaving the
    // button enabled). Reproducing the disabled state requires a protected
    // branch where the gate actually runs.
    accessMock.result = {
      canWrite: false,
      eligible: { roles: ['Admin'], users: [] },
    };
    try {
      const history = [makeAttr({ sha: 'aaaaaaa0000000000', subject: 'edit' })];
      renderWith(
        makeGit({
          status: {
            branch: 'current-company-state',
            hasUpstream: true,
            unmergedFromUpstream: false,
          },
          fetchFileHistory: async () => history,
        }),
      );
      fireEvent.click(await screen.findByText('edit'));
      const undoButton = await screen.findByRole('button', { name: /Undo this save/i });
      await waitFor(() => expect(undoButton).toBeDisabled());
      expect(undoButton.getAttribute('title')).toMatch(/don't have permission/i);
    } finally {
      accessMock.result = { canWrite: true, eligible: { roles: ['Admin'], users: [] } };
    }
  });
});
