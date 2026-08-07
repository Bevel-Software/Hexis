import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import type { BranchInfo, CommitAttribution, WorkingTreeStatus } from '@bevel-software/platform-shared';

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
    fetchFileHistory: async () => [],
    fetchFileDiff: async () => '',
    fetchFileAtChange: async () => ({ baseline: null, current: null }),
    fetchFileComparison: async () => '',
    ...overrides,
  };
}

const workspace = {
  workspaceId: 'ws-1',
  kbDirName: 'knowledge-base',
} as unknown as WorkspaceContextValue;

function renderWith(git: GitContextValue, filePath = 'knowledge-base/Knowledge/Foo.md') {
  return render(
    <WorkspaceContext.Provider value={workspace}>
      <GitContext.Provider value={git}>
        <FileHistoryPanel filePath={filePath} />
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

  it('renders a markdown file\'s save as a rendered-markdown diff', async () => {
    const fetchFileAtChange = vi.fn(async () => ({
      baseline: '# Old title\n\nshared paragraph\n',
      current: '# New title\n\nshared paragraph\n',
    }));
    const history = [makeAttr({ sha: 'aaaaaaa0000000000', subject: 'edit' })];
    renderWith(
      makeGit({
        fetchFileHistory: async () => history,
        fetchFileAtChange,
      }),
    );
    fireEvent.click(await screen.findByText('edit'));
    await waitFor(() =>
      expect(fetchFileAtChange).toHaveBeenCalledWith(
        'knowledge-base/Knowledge/Foo.md',
        'aaaaaaa0000000000',
      ),
    );
    // Rendered markdown, not raw text: both headings appear as real <h1>
    // elements (removed side in red, added side in green).
    expect(await screen.findByRole('heading', { name: 'New title' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Old title' })).toBeInTheDocument();
    expect(screen.getByText('shared paragraph')).toBeInTheDocument();
  });

  it('loads the raw diff when a non-markdown file\'s commit is selected', async () => {
    const fetchFileDiff = vi.fn(async () => '--- a\n+++ b\n@@ -1 +1 @@\n-foo\n+bar\n');
    const history = [makeAttr({ sha: 'aaaaaaa0000000000', subject: 'edit' })];
    renderWith(
      makeGit({
        fetchFileHistory: async () => history,
        fetchFileDiff,
      }),
      'knowledge-base/Knowledge/data.csv',
    );
    const row = await screen.findByText('edit');
    fireEvent.click(row);
    await waitFor(() =>
      expect(fetchFileDiff).toHaveBeenCalledWith(
        'knowledge-base/Knowledge/data.csv',
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
      'knowledge-base/Knowledge/data.csv',
    );
    fireEvent.click(await screen.findByText('edit'));
    expect(await screen.findByText(/No file changes in this save/i)).toBeInTheDocument();
  });

  it('renders the empty state for a markdown save where the file is absent on both sides', async () => {
    const history = [makeAttr({ sha: 'aaaaaaa0000000000', subject: 'edit' })];
    renderWith(
      makeGit({
        fetchFileHistory: async () => history,
        fetchFileAtChange: async () => ({ baseline: null, current: null }),
      }),
    );
    fireEvent.click(await screen.findByText('edit'));
    expect(await screen.findByText(/No file changes in this save/i)).toBeInTheDocument();
  });

});
