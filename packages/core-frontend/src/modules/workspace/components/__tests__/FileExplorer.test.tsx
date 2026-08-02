import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { FileTreeEntry } from '@bevel-software/platform-shared';
import { FileExplorer } from '../FileExplorer';
import { WorkspaceContext, type UploadError, type WorkspaceContextValue } from '../../state/workspace.context';
import { makeWorkspaceFixture } from '../../__tests__/testFixtures';
import { GitContext, type GitContextValue } from '../../../git/state/git.context';
import { AuthContext, type AuthContextValue } from '../../../auth/state/auth.context';
import { PrViewerContext, type PrViewerContextValue } from '../../../pr/state/pr-viewer.context';
import { OpenChangeRequestsContext } from '../../state/open-change-requests.context';

// PullRequestsForMe pulls in router/git wiring we don't want to exercise here;
// stub it so the toolbar can be tested in isolation.
vi.mock('../../../git/components/PullRequestsForMe', () => ({
  PullRequestsForMe: () => null,
}));

// authFetch is the bearer-token wrapper around window.fetch. The Download
// click test asserts the URL + ?download=1 flag, so we mock it at the
// module level rather than monkey-patching globalThis.fetch.
const mockAuthFetch = vi.fn();
vi.mock('../../../../lib/api', () => ({
  authFetch: (...args: unknown[]) => mockAuthFetch(...args),
}));

const EMPTY_TREE: FileTreeEntry = {
  name: '.',
  relativePath: '.',
  type: 'directory',
  children: [],
};

function makeAuth(): AuthContextValue {
  return {
    user: null,
    token: null,
    isLoading: false,
    login: async () => {},
    logout: () => {},
  };
}

function makeGit(): GitContextValue {
  return {
    status: {
      branch: 'alice/draft',
      hasUpstream: true,
      unmergedFromUpstream: false,
    },
    branches: [],
    availability: 'ready',
    lastError: null,
    refreshStatus: async () => null,
    refreshBranches: async () => {},
    createBranch: async () => {},
    deleteBranch: async () => {},
    pull: async () => {},
    fetchForkBase: async () => null,
    revert: async () => ({ sha: 'a', authorName: 'n', authorEmail: 'e', subject: 's', committedAt: '2026-04-29T00:00:00Z' }),
    fetchFileHistory: async () => [],
    fetchFileDiff: async () => '',
    fetchFileComparison: async () => '',
  };
}

function makePrViewer(): PrViewerContextValue {
  return {
    openPrNumber: null,
    detail: null,
    notFound: false,
    selectedPath: null,
    isLoading: false,
    lastError: null,
    openPr: () => {},
    closeViewer: () => {},
    selectPath: () => {},
    refresh: async () => {},
  };
}

interface RenderOptions {
  dispatchUpload?: ReturnType<typeof vi.fn>;
  clearUploadError?: ReturnType<typeof vi.fn>;
  isUploading?: boolean;
  uploadError?: UploadError | null;
  fileTree?: FileTreeEntry | null;
  createFile?: ReturnType<typeof vi.fn>;
  deleteEntry?: ReturnType<typeof vi.fn>;
  openFilePath?: string | null;
  /** Workspace-relative paths with an open change request. */
  openChangeRequestPaths?: string[];
}

function renderExplorer(opts: RenderOptions = {}) {
  const dispatchUpload = opts.dispatchUpload ?? vi.fn().mockResolvedValue(undefined);
  const clearUploadError = opts.clearUploadError ?? vi.fn();
  const createFile = opts.createFile ?? vi.fn().mockResolvedValue(undefined);
  const deleteEntry = opts.deleteEntry ?? vi.fn().mockResolvedValue(undefined);
  // Distinguish "caller wants null tree" from "caller didn't pass anything".
  const fileTree = 'fileTree' in opts ? opts.fileTree ?? null : EMPTY_TREE;
  const workspace: WorkspaceContextValue = makeWorkspaceFixture({
    fileTree,
    uploadError: opts.uploadError ?? null,
    isUploading: opts.isUploading ?? false,
    openFilePath: opts.openFilePath ?? null,
    refreshFileTree: async () => fileTree,
    dispatchUpload,
    clearUploadError,
    createFile,
    deleteEntry,
  });
  return {
    dispatchUpload,
    clearUploadError,
    createFile,
    deleteEntry,
    ...render(
      <MemoryRouter>
        <AuthContext.Provider value={makeAuth()}>
          <WorkspaceContext.Provider value={workspace}>
            <GitContext.Provider value={makeGit()}>
              <PrViewerContext.Provider value={makePrViewer()}>
                <OpenChangeRequestsContext.Provider
                  value={{
                    paths: new Set(opts.openChangeRequestPaths ?? []),
                    forPath: () => [],
                  }}
                >
                  <FileExplorer />
                </OpenChangeRequestsContext.Provider>
              </PrViewerContext.Provider>
            </GitContext.Provider>
          </WorkspaceContext.Provider>
        </AuthContext.Provider>
      </MemoryRouter>,
    ),
  };
}

function getFileInput(): HTMLInputElement {
  return screen.getByTestId('file-explorer-file-input') as HTMLInputElement;
}

describe('FileExplorer toolbar', () => {
  beforeEach(() => {
    cleanup();
  });

  /**
   * A `//` comment placed among JSX CHILDREN is not a comment — it is text,
   * and it renders. TypeScript accepts it, the ratchet ignores it, and every
   * existing test here queries by role or test id, so a four-line source
   * comment once shipped to the top of the file tree in full view. The check
   * is cheap and the failure mode is invisible to everything else.
   */
  it('renders no source comments as page text', () => {
    // The whole container, not the root div: the comment that prompted this
    // was a SIBLING of the tree inside the top-level fragment, so anything
    // scoped to the tree itself would have walked straight past it.
    const { container } = renderExplorer();
    expect(container.textContent ?? '').not.toMatch(/\/\//);
  });

  it('renders the Add files button and the hidden file input', () => {
    renderExplorer();
    const button = screen.getByRole('button', { name: /Add files/i });
    expect(button).toBeInTheDocument();
    expect(button).not.toBeDisabled();
    const input = getFileInput();
    expect(input).toBeInTheDocument();
    expect(input.type).toBe('file');
    expect(input.multiple).toBe(true);
    expect(input.hidden).toBe(true);
  });

  it('triggers the hidden file input when the Add files button is clicked', async () => {
    const user = userEvent.setup();
    renderExplorer();
    const input = getFileInput();
    const clickSpy = vi.spyOn(input, 'click');
    await user.click(screen.getByRole('button', { name: /Add files/i }));
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it('calls dispatchUpload with the selected file at the workspace root', async () => {
    const dispatchUpload = vi.fn().mockResolvedValue(undefined);
    renderExplorer({ dispatchUpload });
    const file = new File(['hello'], 'note.md', { type: 'text/markdown' });
    const input = getFileInput();
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });
    expect(dispatchUpload).toHaveBeenCalledTimes(1);
    const [uploadInput, dir] = dispatchUpload.mock.calls[0];
    expect(uploadInput.kind).toBe('files');
    expect(uploadInput.files).toHaveLength(1);
    expect(uploadInput.files[0].name).toBe('note.md');
    expect(dir).toBe('');
  });

  it('passes every file when multiple are selected at once', async () => {
    const dispatchUpload = vi.fn().mockResolvedValue(undefined);
    renderExplorer({ dispatchUpload });
    const a = new File(['a'], 'a.md');
    const b = new File(['b'], 'b.md');
    const c = new File(['c'], 'c.md');
    await act(async () => {
      fireEvent.change(getFileInput(), { target: { files: [a, b, c] } });
    });
    expect(dispatchUpload).toHaveBeenCalledTimes(1);
    const [uploadInput] = dispatchUpload.mock.calls[0];
    expect(uploadInput.kind).toBe('files');
    expect(uploadInput.files.map((f: File) => f.name)).toEqual(['a.md', 'b.md', 'c.md']);
  });

  it('resets input.value after dispatch so the same file can be re-selected', async () => {
    const dispatchUpload = vi.fn().mockResolvedValue(undefined);
    renderExplorer({ dispatchUpload });
    const input = getFileInput();
    const file = new File(['x'], 'same.md');
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });
    expect(input.value).toBe('');
    // Second selection of the same file fires another dispatch.
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });
    expect(dispatchUpload).toHaveBeenCalledTimes(2);
  });

  it('does not call dispatchUpload when the user cancels the dialog', async () => {
    const dispatchUpload = vi.fn().mockResolvedValue(undefined);
    renderExplorer({ dispatchUpload });
    await act(async () => {
      fireEvent.change(getFileInput(), { target: { files: [] } });
    });
    expect(dispatchUpload).not.toHaveBeenCalled();
  });

  it('disables the Add files button while an upload is in flight', () => {
    renderExplorer({ isUploading: true });
    const button = screen.getByRole('button', { name: 'Add files' });
    expect(button).toBeDisabled();
  });

  it('renders the upload error inline with filename and reason', () => {
    renderExplorer({
      uploadError: { filename: 'huge.bin', reason: 'File exceeds 52428800 byte limit' },
    });
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent("Couldn't add huge.bin");
    expect(alert).toHaveTextContent('File exceeds 52428800 byte limit');
  });

  it('clears the upload error when the dismiss button is clicked', async () => {
    const user = userEvent.setup();
    const clearUploadError = vi.fn();
    renderExplorer({
      uploadError: { filename: 'oops.md', reason: 'boom' },
      clearUploadError,
    });
    await user.click(screen.getByRole('button', { name: /Dismiss upload error/i }));
    expect(clearUploadError).toHaveBeenCalledTimes(1);
  });

  it('does not render the error region when uploadError is null', () => {
    renderExplorer({ uploadError: null });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('routes root-level drag-and-drop through dispatchUpload (parity with the button)', async () => {
    const dispatchUpload = vi.fn().mockResolvedValue(undefined);
    renderExplorer({ dispatchUpload });
    const aside = screen.getByTestId('file-explorer-root');
    const file = new File(['drop'], 'dropped.md');
    await act(async () => {
      fireEvent.drop(aside, {
        dataTransfer: {
          // No `items` (the drop handler tries FileSystem entries first,
          // falling back to `files` for raw FileList drops / older browsers).
          files: [file],
          getData: () => '',
        },
      });
    });
    expect(dispatchUpload).toHaveBeenCalledTimes(1);
    const [uploadInput, dir] = dispatchUpload.mock.calls[0];
    expect(uploadInput.kind).toBe('files');
    expect(uploadInput.files[0].name).toBe('dropped.md');
    expect(dir).toBe('');
  });

  it('renders the loading placeholder when fileTree is null', async () => {
    renderExplorer({ fileTree: null });
    await waitFor(() => {
      expect(screen.getByText(/Loading/i)).toBeInTheDocument();
    });
  });
});

describe('FileExplorer right-click — Download menu (per-path access)', () => {
  beforeEach(() => {
    cleanup();
    mockAuthFetch.mockReset();
  });

  // A tree with one file and one folder so we can exercise both menu items
  // — files render `Download`, folders render `Download as zip`.
  const TREE_WITH_BOTH: FileTreeEntry = {
    name: '.',
    relativePath: '.',
    type: 'directory',
    children: [
      {
        name: 'reports',
        relativePath: 'reports',
        type: 'directory',
        children: [],
      },
      {
        name: 'brief.md',
        relativePath: 'brief.md',
        type: 'file',
      },
    ],
  };

  function renderWithTree() {
    return renderExplorer({ fileTree: TREE_WITH_BOTH });
  }

  // Under the path-scoped `download:` verb model there is no global
  // preflight: the menu items always render. The backend returns 403 at
  // click time for users without permission on that specific path; the
  // click handler surfaces it via an alert.

  it('shows Download on files (no preflight gate)', () => {
    renderWithTree();
    fireEvent.contextMenu(screen.getByText('brief.md'));
    expect(screen.getByText('Download')).toBeInTheDocument();
  });

  it('shows Download as zip on folders (no preflight gate)', () => {
    renderWithTree();
    fireEvent.contextMenu(screen.getByText('reports'));
    expect(screen.getByText('Download as zip')).toBeInTheDocument();
  });

  it('surfaces a 403 from the backend as an alert when the user lacks download on the clicked path', async () => {
    mockAuthFetch.mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => '{"error":"Download permission required"}',
    });
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    try {
      renderWithTree();
      fireEvent.contextMenu(screen.getByText('brief.md'));
      await act(async () => {
        fireEvent.click(screen.getByText('Download'));
      });
      expect(alertSpy).toHaveBeenCalledTimes(1);
      const msg = alertSpy.mock.calls[0][0] as string;
      expect(msg).toContain('brief.md');
      expect(msg).toContain('403');
    } finally {
      alertSpy.mockRestore();
    }
  });

  it('calls /file/raw?download=1 with the entry path and saves the blob', async () => {
    mockAuthFetch.mockResolvedValue({
      ok: true,
      status: 200,
      blob: async () => new Blob(['bytes']),
      text: async () => '',
    });
    const createObjectURL = vi.fn(() => 'blob:fake-url');
    const revokeObjectURL = vi.fn();
    (globalThis.URL as any).createObjectURL = createObjectURL;
    (globalThis.URL as any).revokeObjectURL = revokeObjectURL;

    renderWithTree();
    fireEvent.contextMenu(screen.getByText('brief.md'));
    await act(async () => {
      fireEvent.click(screen.getByText('Download'));
    });

    expect(mockAuthFetch).toHaveBeenCalledTimes(1);
    const url = mockAuthFetch.mock.calls[0][0] as string;
    expect(url).toContain('/api/workspace/ws-1/file/raw');
    expect(url).toContain('path=brief.md');
    expect(url).toContain('download=1');
    expect(createObjectURL).toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:fake-url');
  });

  it('calls /folder/zip?download=1 and triggers a <folder>.zip save when clicking Download as zip on a folder', async () => {
    mockAuthFetch.mockResolvedValue({
      ok: true,
      status: 200,
      blob: async () => new Blob(['PK', 'bytes']),
      text: async () => '',
    });
    const createObjectURL = vi.fn(() => 'blob:fake-zip-url');
    const revokeObjectURL = vi.fn();
    (globalThis.URL as any).createObjectURL = createObjectURL;
    (globalThis.URL as any).revokeObjectURL = revokeObjectURL;

    // Spy on anchor `.download` to confirm we save as <folder>.zip.
    const anchorDownloadValues: string[] = [];
    const realCreate = document.createElement.bind(document);
    const createSpy = vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = realCreate(tag);
      if (tag === 'a') {
        Object.defineProperty(el, 'download', {
          set(val: string) { anchorDownloadValues.push(val); },
          get() { return anchorDownloadValues[anchorDownloadValues.length - 1] ?? ''; },
          configurable: true,
        });
      }
      return el;
    });

    // try/finally guarantees the spy is restored even if an assertion below
    // throws — otherwise document.createElement stays mocked at the module
    // level and contaminates later tests.
    try {
      renderWithTree();
      fireEvent.contextMenu(screen.getByText('reports'));
      await act(async () => {
        fireEvent.click(screen.getByText('Download as zip'));
      });

      expect(mockAuthFetch).toHaveBeenCalledTimes(1);
      const url = mockAuthFetch.mock.calls[0][0] as string;
      expect(url).toContain('/api/workspace/ws-1/folder/zip');
      expect(url).toContain('path=reports');
      expect(url).toContain('download=1');
      expect(anchorDownloadValues).toContain('reports.zip');
    } finally {
      createSpy.mockRestore();
    }
  });
});

// Regression coverage for the FileTreeNode collapse state machine. PR #113
// derived `autoExpanded` reactively without an escape hatch, so clicking the
// chevron on a folder that contained the open file did nothing — the user's
// `expanded=false` was shadowed by `autoExpanded=true` on the next render.
// The fix introduces a tri-state `userIntent` that overrides auto-expand and
// resets when the auto-expand trigger transitions. These tests would have
// caught the original regression.
describe('FileExplorer chevron collapse — userIntent vs autoExpanded', () => {
  beforeEach(() => {
    cleanup();
  });

  const NESTED_TREE: FileTreeEntry = {
    name: '.',
    relativePath: '.',
    type: 'directory',
    children: [
      {
        name: 'docs',
        relativePath: 'docs',
        type: 'directory',
        children: [
          { name: 'a.md', relativePath: 'docs/a.md', type: 'file' },
          { name: 'b.md', relativePath: 'docs/b.md', type: 'file' },
        ],
      },
    ],
  };

  function ExplorerHarness({
    openFilePath,
    fileTree,
  }: {
    openFilePath: string | null;
    fileTree: FileTreeEntry;
  }) {
    const workspace = makeWorkspaceFixture({ fileTree, openFilePath });
    return (
      <MemoryRouter>
        <AuthContext.Provider value={makeAuth()}>
          <WorkspaceContext.Provider value={workspace}>
            <GitContext.Provider value={makeGit()}>
              <PrViewerContext.Provider value={makePrViewer()}>
                <FileExplorer />
              </PrViewerContext.Provider>
            </GitContext.Provider>
          </WorkspaceContext.Provider>
        </AuthContext.Provider>
      </MemoryRouter>
    );
  }

  it('collapses a folder whose open file lives inside it (the PR #113 regression)', () => {
    render(<ExplorerHarness openFilePath="docs/a.md" fileTree={NESTED_TREE} />);
    // Auto-expand kicked in because openFilePath is inside `docs`, so a.md
    // is initially visible in the tree.
    expect(screen.getByText('a.md')).toBeInTheDocument();
    // Click the docs row (event bubbles to the button that toggles userIntent).
    fireEvent.click(screen.getByText('docs'));
    // The whole point: user intent must beat autoExpanded.
    expect(screen.queryByText('a.md')).not.toBeInTheDocument();
    expect(screen.queryByText('b.md')).not.toBeInTheDocument();
  });

  it('re-expands a previously-collapsed folder when a different file inside it becomes the open file', () => {
    const { rerender } = render(
      <ExplorerHarness openFilePath="docs/a.md" fileTree={NESTED_TREE} />,
    );
    fireEvent.click(screen.getByText('docs'));
    expect(screen.queryByText('a.md')).not.toBeInTheDocument();
    // openFilePath transitions to a sibling — autoTrigger flips, userIntent
    // resets to null, autoExpanded re-takes the wheel.
    rerender(<ExplorerHarness openFilePath="docs/b.md" fileTree={NESTED_TREE} />);
    expect(screen.getByText('a.md')).toBeInTheDocument();
    expect(screen.getByText('b.md')).toBeInTheDocument();
  });

  it('renders ancestor folders expanded on deep-link mount so the open file row is visible', () => {
    const deepTree: FileTreeEntry = {
      name: '.',
      relativePath: '.',
      type: 'directory',
      children: [
        {
          name: 'a',
          relativePath: 'a',
          type: 'directory',
          children: [
            {
              name: 'b',
              relativePath: 'a/b',
              type: 'directory',
              children: [
                {
                  name: 'c',
                  relativePath: 'a/b/c',
                  type: 'directory',
                  children: [
                    { name: 'deep.md', relativePath: 'a/b/c/deep.md', type: 'file' },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    render(<ExplorerHarness openFilePath="a/b/c/deep.md" fileTree={deepTree} />);
    // Every ancestor is auto-expanded — without this, deep-link URLs would
    // open the file in the viewer but its tree row would stay hidden.
    expect(screen.getByText('a')).toBeInTheDocument();
    expect(screen.getByText('b')).toBeInTheDocument();
    expect(screen.getByText('c')).toBeInTheDocument();
    expect(screen.getByText('deep.md')).toBeInTheDocument();
  });

  it('keeps folders at depth >= 2 collapsed by default when no file is open', () => {
    const deepTree: FileTreeEntry = {
      name: '.',
      relativePath: '.',
      type: 'directory',
      children: [
        {
          name: 'a',
          relativePath: 'a',
          type: 'directory',
          children: [
            {
              name: 'b',
              relativePath: 'a/b',
              type: 'directory',
              children: [
                {
                  name: 'c',
                  relativePath: 'a/b/c',
                  type: 'directory',
                  children: [
                    { name: 'deep.md', relativePath: 'a/b/c/deep.md', type: 'file' },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    render(<ExplorerHarness openFilePath={null} fileTree={deepTree} />);
    // Root (depth 0) and `a` (depth 1) are below the `depth < 2` threshold
    // and render expanded. `b` (depth 2) renders as a row but its children
    // — `c` and `deep.md` — must not appear.
    expect(screen.getByText('a')).toBeInTheDocument();
    expect(screen.getByText('b')).toBeInTheDocument();
    expect(screen.queryByText('c')).not.toBeInTheDocument();
    expect(screen.queryByText('deep.md')).not.toBeInTheDocument();
  });
});

// The KB level splits the well-known root folders into labelled top-level
// sections. `Data/`, `Agents/` and `Pipelines/` get their own sections like
// Skills/Tools — they must not fold into the Knowledge section.
describe('FileExplorer sections — root folders', () => {
  beforeEach(() => {
    cleanup();
  });

  const dir = (name: string): FileTreeEntry => ({
    name,
    relativePath: name,
    type: 'directory',
    children: [],
  });

  it('renders Data, Agents and Pipelines as their own top-level sections', () => {
    const tree: FileTreeEntry = {
      name: '.',
      relativePath: '.',
      type: 'directory',
      children: [
        dir('KnowledgeBase'),
        dir('Data'),
        dir('Agents'),
        dir('Pipelines'),
        dir('Skills'),
        dir('Tools'),
      ],
    };
    renderExplorer({ fileTree: tree });
    expect(screen.getByText('Knowledge')).toBeInTheDocument();
    expect(screen.getByText('Data')).toBeInTheDocument();
    expect(screen.getByText('Agents')).toBeInTheDocument();
    expect(screen.getByText('Pipelines')).toBeInTheDocument();
    expect(screen.getByText('Skills')).toBeInTheDocument();
    expect(screen.getByText('Tools')).toBeInTheDocument();
  });
});

// Regression: creating a file in a folder the user can't write to used to
// spam the "Failed to create …" alert in a loop. The create input's onBlur
// re-fires onSubmit, and the native alert() steals+returns focus — so
// dismissing the alert blurred the still-mounted input, which re-submitted
// the same doomed create, which re-alerted, forever. The fix closes the
// input (setCreating(null)) BEFORE the fallible create, so there's nothing
// left to re-blur-submit.
describe('FileExplorer create — no alert loop on a write-denied path', () => {
  beforeEach(() => {
    cleanup();
  });

  it('shows the create failure alert exactly once and closes the input', async () => {
    const createFile = vi
      .fn()
      .mockRejectedValue(
        new Error('You don\'t have permission to write to "onboarding/KnowledgeBase/j.md". Eligible: Admin.'),
      );
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    try {
      renderExplorer({ createFile });

      // Open the inline "New file" input on the root row, type a name, Enter.
      await act(async () => {
        fireEvent.click(screen.getAllByTitle('New file')[0]);
      });
      const input = screen.getByPlaceholderText('filename') as HTMLInputElement;
      await act(async () => {
        fireEvent.change(input, { target: { value: 'j.md' } });
        fireEvent.keyDown(input, { key: 'Enter' });
      });

      // The create was attempted once and rejected.
      expect(createFile).toHaveBeenCalledTimes(1);
      // The input is gone — so it can no longer re-blur-submit.
      expect(screen.queryByPlaceholderText('filename')).not.toBeInTheDocument();

      // Simulate the focus returning after the user dismisses the native
      // alert. Before the fix this blur re-fired onSubmit; now the input is
      // unmounted so nothing happens.
      await act(async () => {
        fireEvent.blur(input);
      });

      expect(alertSpy).toHaveBeenCalledTimes(1);
      expect(createFile).toHaveBeenCalledTimes(1);
      expect(alertSpy.mock.calls[0][0]).toContain('Failed to create j.md');
    } finally {
      alertSpy.mockRestore();
    }
  });
});

// ── WP2: names and one caret, nothing else ──

describe('FileExplorer rows — the prototype tree', () => {
  const TREE: FileTreeEntry = {
    name: '.',
    relativePath: '.',
    type: 'directory',
    children: [
      { name: 'reports', relativePath: 'reports', type: 'directory', children: [] },
      {
        name: 'docs',
        relativePath: 'docs',
        type: 'directory',
        children: [{ name: 'a.md', relativePath: 'docs/a.md', type: 'file' }],
      },
      { name: 'brief.md', relativePath: 'brief.md', type: 'file' },
    ],
  };

  beforeEach(() => {
    cleanup();
    mockAuthFetch.mockReset();
  });

  // The folder icon repeated what the caret said and the file icon repeated
  // what the extension said. Both are gone; the row is a name and a caret.
  it('renders no folder or per-extension file icons', () => {
    const { container } = renderExplorer({ fileTree: TREE });
    // The iconify glyphs mounted as <svg> siblings of the name; lucide's
    // Folder/FolderOpen did too. What survives in a row is at most the caret.
    expect(container.querySelector('.iconify')).toBeNull();
    const row = screen.getByText('brief.md').closest('button')!;
    expect(row.querySelectorAll('svg')).toHaveLength(0);
  });

  it('gives a childless folder no caret and does not toggle it', async () => {
    renderExplorer({ fileTree: TREE });
    const empty = screen.getByText('reports').closest('button')!;
    expect(empty.querySelectorAll('svg')).toHaveLength(0);
    expect(empty).toHaveAttribute('aria-expanded');

    const withKids = screen.getByText('docs').closest('button')!;
    expect(withKids.querySelectorAll('svg')).toHaveLength(1);
  });

  it('marks directory rows with aria-expanded and the open file with aria-current', () => {
    renderExplorer({ fileTree: TREE, openFilePath: 'docs/a.md' });
    expect(screen.getByText('docs').closest('button')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('a.md').closest('button')).toHaveAttribute('aria-current', 'true');
    expect(screen.getByText('brief.md').closest('button')).toHaveAttribute('aria-current', 'false');
  });

  // The one prototype context-menu item the platform never had.
  it('offers Copy path in the context menu and writes the entry path', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    renderExplorer({ fileTree: TREE });

    fireEvent.contextMenu(screen.getByText('brief.md'));
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: /Copy path/i }));
    });
    expect(writeText).toHaveBeenCalledWith('brief.md');
  });

  it('offers Copy path on a folder row too', () => {
    renderExplorer({ fileTree: TREE });
    fireEvent.contextMenu(screen.getByText('reports'));
    expect(screen.getByRole('menuitem', { name: /Copy path/i })).toBeInTheDocument();
  });

  // MenuPanel is presentation only, so the dismissal is the caller's — and a
  // menu you can only close by picking something is a keyboard trap.
  it('closes the context menu on Escape and hands focus back to the row', async () => {
    renderExplorer({ fileTree: TREE });
    const row = screen.getByText('brief.md').closest('button')!;
    fireEvent.contextMenu(screen.getByText('brief.md'));
    expect(screen.getByRole('menu')).toBeInTheDocument();

    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(row);
  });

  it('closes the context menu on an outside click', async () => {
    renderExplorer({ fileTree: TREE });
    fireEvent.contextMenu(screen.getByText('brief.md'));
    expect(screen.getByRole('menu')).toBeInTheDocument();

    await act(async () => {
      fireEvent.mouseDown(document.body);
    });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('still deletes from the context menu', async () => {
    const deleteEntry = vi.fn(async () => {});
    renderExplorer({ fileTree: TREE, deleteEntry });
    fireEvent.contextMenu(screen.getByText('brief.md'));
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: /Delete/i }));
    });
    expect(deleteEntry).toHaveBeenCalledWith('brief.md');
  });

  // WP6: the tree consumes the SHARED, workspace-relative set. The two path
  // spaces are joined in the provider; here the row just has to light up for
  // the path the tree actually holds.
  it('marks a row whose file has an open change request', () => {
    renderExplorer({
      fileTree: TREE,
      openChangeRequestPaths: ['brief.md'],
    });
    const marked = screen.getByText('brief.md').closest('button')!;
    expect(marked.querySelector('[title="Open change request"]')).not.toBeNull();
    const unmarked = screen.getByText('docs').closest('button')!;
    expect(unmarked.querySelector('[title="Open change request"]')).toBeNull();
  });
});
