import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { BranchInfo, CommitAttribution, WorkingTreeStatus } from '@bevel-software/platform-shared';

/**
 * The version pane the panel now mounts for every non-markdown file reads
 * bytes and resolves the file's `download:` verb. Both are stubbed so these
 * tests stay about the PANEL — which save is selected, and which of the two
 * histories it routes to.
 */
const apiMock = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('../../../lib/api', () => ({ authFetch: apiMock.authFetch }));
const accessMock = vi.hoisted(() => ({ fetchFileAccess: vi.fn() }));
vi.mock('../../access/api', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchFileAccess: accessMock.fetchFileAccess,
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
    <MemoryRouter initialEntries={[`/workspace/ws-1/${filePath}`]}>
      <WorkspaceContext.Provider value={workspace}>
        <GitContext.Provider value={git}>
          <FileHistoryPanel filePath={filePath} />
        </GitContext.Provider>
      </WorkspaceContext.Provider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  apiMock.authFetch.mockReset();
  apiMock.authFetch.mockResolvedValue({
    ok: true,
    status: 200,
    blob: async () => new Blob(['bytes']),
    arrayBuffer: async () => new ArrayBuffer(8),
    text: async () => '',
  });
  accessMock.fetchFileAccess.mockReset();
  accessMock.fetchFileAccess.mockResolvedValue({
    canWrite: false,
    canDownload: true,
    eligible: { roles: [], users: [] },
    owners: { roles: [], users: [] },
  });
  (globalThis.URL as unknown as { createObjectURL: unknown }).createObjectURL = vi.fn(
    () => 'blob:fake-url',
  );
  (globalThis.URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = vi.fn();
});

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

  it('loads the line changes for a text file no viewer renders', async () => {
    const fetchFileDiff = vi.fn(async () => '--- a\n+++ b\n@@ -1 +1 @@\n-foo\n+bar\n');
    const history = [makeAttr({ sha: 'aaaaaaa0000000000', subject: 'edit' })];
    renderWith(
      makeGit({
        fetchFileHistory: async () => history,
        fetchFileDiff,
      }),
      'knowledge-base/Knowledge/notes.txt',
    );
    const row = await screen.findByText('edit');
    fireEvent.click(row);
    await waitFor(() =>
      expect(fetchFileDiff).toHaveBeenCalledWith(
        'knowledge-base/Knowledge/notes.txt',
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
      'knowledge-base/Knowledge/notes.txt',
    );
    fireEvent.click(await screen.findByText('edit'));
    expect(await screen.findByText(/No file changes in this save/i)).toBeInTheDocument();
  });

  it('routes a previewable file\'s save to the version pane, not the patch', async () => {
    // A CSV is previewable, so the pane shows the table of that save with the
    // line changes a click away — where it used to show the patch and nothing
    // else.
    const history = [makeAttr({ sha: 'aaaaaaa0000000000', subject: 'edit' })];
    renderWith(
      makeGit({
        fetchFileHistory: async () => history,
        fetchFileDiff: async () => '--- a\n+++ b\n@@ -1 +1 @@\n-a,b\n+a,c\n',
        fetchFileAtChange: async () => ({ baseline: 'a,b', current: 'region,total\n EMEA,7' }),
      }),
      'knowledge-base/Knowledge/data.csv',
    );
    fireEvent.click(await screen.findByText('edit'));
    expect(await screen.findByText('region')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Download this version' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Source changes' }));
    expect(await screen.findByText(/\+a,c/)).toBeInTheDocument();
  });

  it('leaves a markdown history untouched: no version pane, no download', async () => {
    const fetchFileDiff = vi.fn(async () => 'unused');
    const history = [makeAttr({ sha: 'aaaaaaa0000000000', subject: 'edit' })];
    renderWith(
      makeGit({
        fetchFileHistory: async () => history,
        fetchFileDiff,
        fetchFileAtChange: async () => ({ baseline: '# Old\n', current: '# New\n' }),
      }),
    );
    fireEvent.click(await screen.findByText('edit'));
    expect(await screen.findByRole('heading', { name: 'New' })).toBeInTheDocument();
    // The markdown path reads before/after contents and nothing else — no
    // patch, no version pane, no bytes.
    expect(fetchFileDiff).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Download this version' })).toBeNull();
    expect(screen.queryByText(/As saved/)).toBeNull();
    expect(apiMock.authFetch).not.toHaveBeenCalled();
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

  // A past save's images are not the checked-out tree's: the panel passes no
  // resolver, so both sides name the file rather than show today's bytes.
  it('names the images in a past save instead of showing the checked-out copies', async () => {
    const history = [makeAttr({ sha: 'aaaaaaa0000000000', subject: 'edit' })];
    const { container } = renderWith(
      makeGit({
        fetchFileHistory: async () => history,
        fetchFileAtChange: async () => ({
          baseline: '![Old](./assets/old.png)\n',
          current: '![New](./assets/new.png)\n',
        }),
      }),
    );
    fireEvent.click(await screen.findByText('edit'));
    expect(
      await screen.findByRole('img', { name: /Baseline image not shown: \.\/assets\/old.png/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /Image not shown: \.\/assets\/new.png/ })).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
  });
});
