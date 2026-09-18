import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { configureBranchModel, type FileTreeEntry } from '@bevel-software/platform-shared';
import { FileExplorer } from '../FileExplorer';
import { WorkspaceContext, type UploadError, type WorkspaceContextValue } from '../../state/workspace.context';
import { makeWorkspaceFixture } from '../../__tests__/testFixtures';
import { GitContext, type GitContextValue } from '../../../git/state/git.context';
import { AuthContext, type AuthContextValue } from '../../../auth/state/auth.context';
import { OpenChangeRequestsContext } from '../../state/open-change-requests.context';

// authFetch is the bearer-token wrapper around window.fetch. The Download
// click test asserts the URL + ?download=1 flag, so we mock it at the
// module level rather than monkey-patching globalThis.fetch.
const mockAuthFetch = vi.fn();
vi.mock('../../../../lib/api', () => ({
  authFetch: (...args: unknown[]) => mockAuthFetch(...args),
}));

// The sheet itself is covered by the access module's own tests; here only
// WHICH workspace and proposal the tree hands it matters.
vi.mock('../../../access/components/ManageAccessDialog', () => ({
  ManageAccessDialog: (props: {
    entry: FileTreeEntry;
    workspaceId?: string;
    proposal?: { number: number; branch: string | null };
    onManageAncestor?: (entry: FileTreeEntry) => void;
  }) => (
    <div
      data-testid="manage-access-dialog"
      data-path={props.entry.relativePath}
      data-workspace={props.workspaceId ?? ''}
      data-proposal={JSON.stringify(props.proposal ?? null)}
    >
      {/* Stands in for the sheet's `Manage <folder> →` on an inherited grant. */}
      <button
        type="button"
        onClick={() =>
          props.onManageAncestor?.({ name: 'docs', relativePath: 'docs', type: 'directory', children: [] })
        }
      >
        Manage docs →
      </button>
    </div>
  ),
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
    fetchFileHistory: async () => [],
    fetchFileDiff: async () => '',
    fetchFileAtChange: async () => ({ baseline: null, current: null }),
    fetchFileComparison: async () => '',
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
  moveEntry?: ReturnType<typeof vi.fn>;
  /** The workspace id — the encoded branch name, so it decides "protected". */
  workspaceId?: string;
  openFilePath?: string | null;
  /** Workspace-relative paths with an open change request. */
  openChangeRequestPaths?: string[];
  /** The caller's own open requests: workspace-relative path → CR number. */
  minePaths?: Map<string, number>;
}

function renderExplorer(opts: RenderOptions = {}) {
  const dispatchUpload = opts.dispatchUpload ?? vi.fn().mockResolvedValue(undefined);
  const clearUploadError = opts.clearUploadError ?? vi.fn();
  const createFile = opts.createFile ?? vi.fn().mockResolvedValue(undefined);
  const deleteEntry = opts.deleteEntry ?? vi.fn().mockResolvedValue(undefined);
  const moveEntry = opts.moveEntry ?? vi.fn().mockResolvedValue(undefined);
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
    moveEntry,
    ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}),
  });
  const ui = (ws: WorkspaceContextValue) => (
      <MemoryRouter>
        <AuthContext.Provider value={makeAuth()}>
          <WorkspaceContext.Provider value={ws}>
            <GitContext.Provider value={makeGit()}>
                <OpenChangeRequestsContext.Provider
                  value={{
                    paths: new Set(opts.openChangeRequestPaths ?? []),
                    // A suggestion row resolves its request through forPath —
                    // synthesize a summary for every minePaths entry so the
                    // shared dialog has something to open.
                    forPath: (p) => {
                      const n = opts.minePaths?.get(p);
                      return n === undefined
                        ? []
                        : ([
                            {
                              number: n,
                              title: 'Suggested change',
                              branch: 'suggestions/me/knowledge',
                              base: 'main',
                              state: 'open',
                              createdAt: '2026-08-01T00:00:00.000Z',
                              touchedNodePaths: [p],
                              author: { login: 'user-x' },
                              review: { approvals: 0, changesRequested: 0, pendingLogins: [] },
                              url: '',
                            },
                          ] as never);
                    },
                    minePaths: opts.minePaths ?? new Map(),
                    mineNumbers: new Set(opts.minePaths?.values() ?? []),
                  }}
                >
                  <FileExplorer />
                </OpenChangeRequestsContext.Provider>
            </GitContext.Provider>
          </WorkspaceContext.Provider>
        </AuthContext.Provider>
      </MemoryRouter>
  );
  const result = render(ui(workspace));
  return {
    moveEntry,
    dispatchUpload,
    clearUploadError,
    createFile,
    deleteEntry,
    ...result,
    /** Re-render the same explorer as though the user switched workspace. */
    switchWorkspace: (workspaceId: string) => result.rerender(ui({ ...workspace, workspaceId })),
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

describe('FileExplorer right-click: Download menu (per-path access)', () => {
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

  /** The `/access` body, with only the verdict this menu reads varying. */
  function accessBody(canDownload: boolean) {
    return {
      canRead: true,
      canWrite: true,
      canDownload,
      canOwner: false,
      eligible: { roles: [], users: [] },
      readers: { restricted: false, roles: [], users: [] },
      owners: { roles: [], users: [] },
      downloaders: { roles: [], users: [] },
      sources: {},
    };
  }

  /**
   * One `authFetch` for two very different calls: the menu's access preflight
   * on open, and the download itself on click. Routed by URL so a test can
   * state the verdict and the download outcome independently — which is the
   * whole point of the late-403 case, where they disagree.
   */
  function routeAuthFetch(opts: { canDownload: boolean; download?: unknown }) {
    mockAuthFetch.mockImplementation((url: string) =>
      Promise.resolve(
        url.includes('/access?')
          ? { ok: true, status: 200, json: async () => accessBody(opts.canDownload), text: async () => '' }
          : opts.download,
      ),
    );
  }

  /** The access lookups made so far, in order. */
  const accessCalls = () =>
    mockAuthFetch.mock.calls.map((c) => c[0] as string).filter((u) => u.includes('/access?'));
  /** The download requests made so far — everything that is not a lookup. */
  const downloadCalls = () =>
    mockAuthFetch.mock.calls.map((c) => c[0] as string).filter((u) => !u.includes('/access?'));

  /**
   * The blob-URL pair the download path uses. `Object.assign` rather than a
   * cast: happy-dom's URL has no object-URL methods to widen, and the cast
   * every caller used to write is the one thing a helper should absorb.
   */
  function stubObjectUrls(url = 'blob:fake-url') {
    const createObjectURL = vi.fn(() => url);
    const revokeObjectURL = vi.fn();
    Object.assign(globalThis.URL, { createObjectURL, revokeObjectURL });
    return { createObjectURL, revokeObjectURL };
  }

  function renderWithTree() {
    return renderExplorer({ fileTree: TREE_WITH_BOTH });
  }

  /** Right-click a row and wait for the menu's access lookup to land. */
  async function openMenuOn(label: string) {
    fireEvent.contextMenu(screen.getByText(label));
    await act(async () => {});
  }

  it('asks for the entry access once when the menu opens, and enables Download', async () => {
    routeAuthFetch({ canDownload: true });
    renderWithTree();
    await openMenuOn('brief.md');

    expect(accessCalls()).toHaveLength(1);
    expect(accessCalls()[0]).toContain('/api/workspace/ws-1/access?path=brief.md');
    expect(accessCalls()[0]).toContain('kind=file');
    const item = screen.getByRole('menuitem', { name: 'Download' });
    expect(item).not.toHaveAttribute('aria-disabled');
    expect(item).not.toHaveAttribute('title');
  });

  it('disables Download with the reason on a file the caller may only read', async () => {
    routeAuthFetch({ canDownload: false });
    renderWithTree();
    await openMenuOn('brief.md');

    const item = screen.getByRole('menuitem', { name: 'Download' });
    expect(item).toHaveAttribute('aria-disabled', 'true');
    expect(item).toHaveAttribute('title', "You don't have download permission for this item");
    // Nothing is attempted on a click, and the menu stays open saying why.
    fireEvent.click(item);
    expect(downloadCalls()).toHaveLength(0);
    expect(screen.getByRole('menuitem', { name: 'Download' })).toBeInTheDocument();
  });

  it('disables Download as zip with the reason on a folder, asked as a folder', async () => {
    routeAuthFetch({ canDownload: false });
    renderWithTree();
    await openMenuOn('reports');

    expect(accessCalls()).toHaveLength(1);
    expect(accessCalls()[0]).toContain('path=reports');
    expect(accessCalls()[0]).toContain('kind=folder');
    const item = screen.getByRole('menuitem', { name: 'Download as zip' });
    expect(item).toHaveAttribute('aria-disabled', 'true');
    expect(item).toHaveAttribute('title', "You don't have download permission for this item");
    fireEvent.click(item);
    expect(downloadCalls()).toHaveLength(0);
  });

  /**
   * `aria-disabled`, not `disabled`, is what keeps the reason reachable — so
   * the item is still focusable, and refusing the ACTIVATION (not the click
   * event) is what has to stop the keyboard path.
   */
  it('cannot be triggered from the keyboard while it is disabled', async () => {
    const user = userEvent.setup();
    routeAuthFetch({ canDownload: false });
    renderWithTree();
    await openMenuOn('brief.md');

    const item = screen.getByRole('menuitem', { name: 'Download' });
    item.focus();
    expect(document.activeElement).toBe(item);
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(downloadCalls()).toHaveLength(0);
    // The menu did not close either: nothing happened at all.
    expect(screen.getByRole('menuitem', { name: 'Download' })).toBeInTheDocument();
  });

  // The control for the test above: the same keys DO activate the item when
  // the verdict allows it, so the refusal above is the guard working and not
  // a menu that simply cannot be driven from the keyboard.
  it('activates Download from the keyboard when the verdict allows it', async () => {
    const user = userEvent.setup();
    routeAuthFetch({
      canDownload: true,
      download: { ok: true, status: 200, blob: async () => new Blob(['bytes']), text: async () => '' },
    });
    stubObjectUrls();
    renderWithTree();
    await openMenuOn('brief.md');

    screen.getByRole('menuitem', { name: 'Download' }).focus();
    await act(async () => {
      await user.keyboard('{Enter}');
    });
    expect(downloadCalls()).toHaveLength(1);
  });

  it('leaves Download enabled while the lookup is still in flight', async () => {
    // Never resolves: the verdict is unknown for the whole test.
    mockAuthFetch.mockImplementation(() => new Promise(() => {}));
    renderWithTree();
    fireEvent.contextMenu(screen.getByText('brief.md'));

    const item = screen.getByRole('menuitem', { name: 'Download' });
    expect(item).not.toHaveAttribute('aria-disabled');
  });

  it('leaves Download enabled when the lookup itself fails', async () => {
    mockAuthFetch.mockImplementation((url: string) =>
      url.includes('/access?')
        ? Promise.resolve({ ok: false, status: 500, json: async () => ({ error: 'boom' }), text: async () => 'boom' })
        : Promise.resolve({ ok: true, status: 200, blob: async () => new Blob(['b']), text: async () => '' }),
    );
    renderWithTree();
    await openMenuOn('brief.md');

    expect(screen.getByRole('menuitem', { name: 'Download' })).not.toHaveAttribute('aria-disabled');
  });

  /**
   * The late 403 — permission changed between the menu opening and the click.
   * It is reported where the row is, never through `window.alert`: a modal
   * popup for a refused download stops the whole app to say one line.
   */
  it('shows an inline notice, not an alert, when a download is refused after the menu opened', async () => {
    routeAuthFetch({
      canDownload: true,
      download: { ok: false, status: 403, text: async () => '{"error":"Download permission required"}' },
    });
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    try {
      renderWithTree();
      await openMenuOn('brief.md');
      await act(async () => {
        fireEvent.click(screen.getByRole('menuitem', { name: 'Download' }));
      });

      expect(alertSpy).not.toHaveBeenCalled();
      const notice = await screen.findByTestId('tree-download-error');
      expect(notice).toHaveAttribute('role', 'alert');
      expect(notice.textContent).toContain('brief.md');
      expect(notice.textContent).toContain("You don't have download permission for this item");

      // Dismissible, like every other banner in this tree.
      fireEvent.click(screen.getByRole('button', { name: /Dismiss download error/i }));
      expect(screen.queryByTestId('tree-download-error')).toBeNull();
    } finally {
      alertSpy.mockRestore();
    }
  });

  it('reports a non-403 download failure inline too', async () => {
    routeAuthFetch({
      canDownload: true,
      download: { ok: false, status: 500, text: async () => 'boom' },
    });
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    try {
      renderWithTree();
      await openMenuOn('brief.md');
      await act(async () => {
        fireEvent.click(screen.getByRole('menuitem', { name: 'Download' }));
      });
      expect(alertSpy).not.toHaveBeenCalled();
      const notice = await screen.findByTestId('tree-download-error');
      expect(notice.textContent).toContain('500');
    } finally {
      alertSpy.mockRestore();
    }
  });

  /**
   * Two downloads for the same row can overlap — the menu closes on click but
   * the ROW does not, so a second Download is one reopen away — and the two
   * can land out of order. The notice speaks for the LATEST attempt only:
   * a slow refusal arriving after a fast success would otherwise report a
   * failed download the user had just watched succeed.
   */
  it('ignores a superseded download outcome instead of reporting a stale failure', async () => {
    let releaseRefusal: () => void = () => {};
    const slowRefusal = new Promise<unknown>((resolve) => {
      releaseRefusal = () =>
        resolve({ ok: false, status: 403, text: async () => '{"error":"Download permission required"}' });
    });
    let downloadsSeen = 0;
    mockAuthFetch.mockImplementation((url: string) => {
      if (url.includes('/access?')) {
        return Promise.resolve({ ok: true, status: 200, json: async () => accessBody(true), text: async () => '' });
      }
      downloadsSeen += 1;
      // First click hangs, second answers at once — the out-of-order case.
      return downloadsSeen === 1
        ? slowRefusal
        : Promise.resolve({ ok: true, status: 200, blob: async () => new Blob(['bytes']), text: async () => '' });
    });
    stubObjectUrls();

    renderWithTree();
    await openMenuOn('brief.md');
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Download' }));
    });
    // Reopen and click again while the first attempt is still in flight.
    await openMenuOn('brief.md');
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Download' }));
    });
    expect(downloadCalls()).toHaveLength(2);
    expect(screen.queryByTestId('tree-download-error')).toBeNull();

    // The stale refusal lands last. It belongs to a download two clicks ago.
    await act(async () => {
      releaseRefusal();
      await slowRefusal;
    });
    expect(screen.queryByTestId('tree-download-error')).toBeNull();
  });

  it('calls /file/raw?download=1 with the entry path and saves the blob', async () => {
    routeAuthFetch({
      canDownload: true,
      download: { ok: true, status: 200, blob: async () => new Blob(['bytes']), text: async () => '' },
    });
    const { createObjectURL, revokeObjectURL } = stubObjectUrls();

    renderWithTree();
    await openMenuOn('brief.md');
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Download' }));
    });

    expect(downloadCalls()).toHaveLength(1);
    const url = downloadCalls()[0];
    expect(url).toContain('/api/workspace/ws-1/file/raw');
    expect(url).toContain('path=brief.md');
    expect(url).toContain('download=1');
    expect(createObjectURL).toHaveBeenCalled();
    // The revoke is DEFERRED a tick (setTimeout 0) so the click's download
    // starts before the blob URL dies — hence waitFor, not a sync assert.
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith('blob:fake-url'));
  });

  it('calls /folder/zip?download=1 and triggers a <folder>.zip save when clicking Download as zip on a folder', async () => {
    routeAuthFetch({
      canDownload: true,
      download: { ok: true, status: 200, blob: async () => new Blob(['PK', 'bytes']), text: async () => '' },
    });
    stubObjectUrls('blob:fake-zip-url');

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
      await openMenuOn('reports');
      await act(async () => {
        fireEvent.click(screen.getByRole('menuitem', { name: 'Download as zip' }));
      });

      expect(downloadCalls()).toHaveLength(1);
      const url = downloadCalls()[0];
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
describe('FileExplorer chevron collapse: userIntent vs autoExpanded', () => {
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
                <FileExplorer />
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
// sections — with one deliberate exception, `Plugins/`.
describe('FileExplorer sections: root folders', () => {
  beforeEach(() => {
    cleanup();
  });

  const dir = (name: string): FileTreeEntry => ({
    name,
    relativePath: name,
    type: 'directory',
    children: [],
  });

  /**
   * `Data/`, `Agents/` and `Pipelines/` are never created by core — a
   * deployment that owns the agentic execution layer seeds them. When they ARE
   * there they get their own sections, and in particular must not fold into
   * Knowledge the way a stray content folder does.
   */
  it('renders Data, Agents and Pipelines as their own sections when present', () => {
    const tree: FileTreeEntry = {
      name: '.',
      relativePath: '.',
      type: 'directory',
      children: [dir('KnowledgeBase'), dir('Data'), dir('Agents'), dir('Pipelines')],
    };
    renderExplorer({ fileTree: tree });
    expect(screen.getByText('Knowledge')).toBeInTheDocument();
    expect(screen.getByText('Data')).toBeInTheDocument();
    expect(screen.getByText('Agents')).toBeInTheDocument();
    expect(screen.getByText('Pipelines')).toBeInTheDocument();
  });

  /**
   * `Plugins/` is the Skills & Tools app's storage, and that app presents it as
   * plugins, skills and tools. Listing it here offered a second, worse way in —
   * raw markdown editing of a SKILL.md, on a folder whose access is managed
   * from the plugin page.
   *
   * Not shown, and NOT folded into Knowledge either: it is a reserved root, so
   * the "stray content folder" path must not pick it up. Both halves are
   * asserted, because dropping it from the reserved set would still hide the
   * section while quietly moving the whole folder under Knowledge.
   */
  it('never shows Plugins in the knowledge view', () => {
    const tree: FileTreeEntry = {
      name: '.',
      relativePath: '.',
      type: 'directory',
      children: [dir('KnowledgeBase'), dir('Plugins')],
    };
    renderExplorer({ fileTree: tree });
    expect(screen.getByText('Knowledge')).toBeInTheDocument();
    expect(screen.queryByText('Plugins')).not.toBeInTheDocument();
  });

  /** A KB whose only root is Plugins still has a knowledge view — an empty one. */
  it('does not fall back to the flat tree when Plugins is the only root', () => {
    const tree: FileTreeEntry = {
      name: '.',
      relativePath: '.',
      type: 'directory',
      children: [dir('Plugins')],
    };
    renderExplorer({ fileTree: tree });
    expect(screen.queryByText('Plugins')).not.toBeInTheDocument();
  });
});

// Regression: creating a file in a folder the user can't write to used to
// spam the "Failed to create …" alert in a loop. The create input's onBlur
// re-fires onSubmit, and the native alert() steals+returns focus — so
// dismissing the alert blurred the still-mounted input, which re-submitted
// the same doomed create, which re-alerted, forever. The fix closes the
// input (setCreating(null)) BEFORE the fallible create, so there's nothing
// left to re-blur-submit.
describe('FileExplorer create: no alert loop on a write-denied path', () => {
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

describe('FileExplorer rows: the prototype tree', () => {
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

  it('gives a childless folder the caret, like any folder', () => {
    renderExplorer({ fileTree: TREE });
    // Without the caret an empty folder reads as a file.
    const empty = screen.getByText('reports').closest('button')!;
    expect(empty.querySelectorAll('svg')).toHaveLength(1);
    expect(empty).toHaveAttribute('aria-expanded');

    const withKids = screen.getByText('docs').closest('button')!;
    expect(withKids.querySelectorAll('svg')).toHaveLength(1);
  });

  it('shows one muted, inert "Empty" row under an open empty folder', () => {
    const tree: FileTreeEntry = {
      name: '.',
      relativePath: '.',
      type: 'directory',
      children: [
        {
          name: 'outer',
          relativePath: 'outer',
          type: 'directory',
          children: [{ name: 'reports', relativePath: 'outer/reports', type: 'directory', children: [] }],
        },
      ],
    };
    renderExplorer({ fileTree: tree });
    // Depth 2 starts closed, so nothing says "Empty" until it is opened.
    const reports = screen.getByText('reports').closest('button')!;
    expect(reports).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Empty')).not.toBeInTheDocument();

    fireEvent.click(reports);
    expect(reports).toHaveAttribute('aria-expanded', 'true');
    const emptyRows = screen.getAllByText('Empty');
    expect(emptyRows).toHaveLength(1);
    const emptyRow = emptyRows[0].closest('[data-tree-empty]') as HTMLElement;
    expect(emptyRow).toHaveClass('text-ink-faint');
    // A statement, not a row: no controls, no path, nothing to focus.
    expect(emptyRow.querySelector('button, [tabindex], svg')).toBeNull();
    expect(emptyRow).not.toHaveAttribute('data-tree-path');
    // One indent step deeper than the folder, where a first child would sit.
    expect(emptyRow.style.paddingLeft).toBe(`${parseInt(reports.parentElement!.style.paddingLeft) + 13}px`);

    fireEvent.click(reports);
    expect(screen.queryByText('Empty')).not.toBeInTheDocument();
  });

  it('truncates a long file name in the middle, keeping its last 8 characters', () => {
    const name = 'Sidebar-Rows-Say-What-They-Are.md';
    const tree: FileTreeEntry = {
      name: '.',
      relativePath: '.',
      type: 'directory',
      children: [{ name, relativePath: name, type: 'file' }],
    };
    renderExplorer({ fileTree: tree });
    const row = screen.getByRole('button', { name });
    const lead = row.querySelector('[data-name-lead]')!;
    const tail = row.querySelector('[data-name-tail]')!;
    // The lead is what shrinks behind an ellipsis; the tail never does.
    expect(lead.textContent).toBe('Sidebar-Rows-Say-What-The');
    expect(lead).toHaveClass('truncate');
    expect(tail.textContent).toBe('y-Are.md');
    expect(tail).toHaveClass('flex-none');
    expect(tail).not.toHaveClass('truncate');
    // Together they are the whole name, so a name that fits is unchanged.
    expect(`${lead.textContent}${tail.textContent}`).toBe(name);
  });

  it('renders a short file name whole, in one piece', () => {
    renderExplorer({ fileTree: TREE });
    const name = screen.getByText('brief.md');
    expect(name.tagName).toBe('SPAN');
    expect(name).toHaveClass('truncate');
    expect(name.closest('button')!.querySelector('[data-name-tail]')).toBeNull();
  });

  it('keeps end truncation for a folder name — no extension to protect', () => {
    const folder = 'a-very-long-folder-name-that-will-not-fit';
    const tree: FileTreeEntry = {
      name: '.',
      relativePath: '.',
      type: 'directory',
      children: [{ name: folder, relativePath: folder, type: 'directory', children: [] }],
    };
    renderExplorer({ fileTree: tree });
    const name = screen.getByText(folder);
    expect(name).toHaveClass('truncate');
    expect(name.closest('button')!.querySelector('[data-name-tail]')).toBeNull();
  });

  it('marks directory rows with aria-expanded and the open file with aria-current', () => {
    renderExplorer({ fileTree: TREE, openFilePath: 'docs/a.md' });
    expect(screen.getByText('docs').closest('button')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('a.md').closest('button')).toHaveAttribute('aria-current', 'true');
    expect(screen.getByText('brief.md').closest('button')).toHaveAttribute('aria-current', 'false');
  });

  // The one prototype context-menu item the platform never had.
  // Root-anchored, so the text pasted into a Markdown link opens the file from
  // any folder rather than resolving against the linking file's own folder.
  it('offers Copy path in the context menu and writes the root-anchored entry path', async () => {
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
    expect(writeText).toHaveBeenCalledWith('/brief.md');
  });

  it('copies a nested entry as its full root-anchored path', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    renderExplorer({ fileTree: TREE });

    fireEvent.contextMenu(screen.getByText('a.md'));
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: /Copy path/i }));
    });
    expect(writeText).toHaveBeenCalledWith('/docs/a.md');
  });

  it('does not offer Copy path on the workspace root, which would copy "/."', () => {
    renderExplorer({ fileTree: TREE });
    fireEvent.contextMenu(screen.getByText('reports'));
    expect(screen.getByRole('menuitem', { name: /Copy path/i })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.contextMenu(screen.getAllByText('.')[0]);
    expect(screen.queryByRole('menuitem', { name: /Copy path/i })).not.toBeInTheDocument();
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

  it('still deletes from the context menu, once confirmed', async () => {
    const deleteEntry = vi.fn(async () => {});
    renderExplorer({ fileTree: TREE, deleteEntry });
    fireEvent.contextMenu(screen.getByText('brief.md'));
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: /Delete/i }));
    });
    expect(deleteEntry).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
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

  /**
   * The tree shows files from two places: this branch, and the caller's own
   * open change requests. A proposed file that does not exist on the branch
   * is synthesized in — coloured differently, and a click opens the change
   * request, because there is no content on this branch to open.
   */
  it('shows my proposed-only file as a suggestion row that opens the change request', async () => {
    renderExplorer({
      fileTree: TREE,
      minePaths: new Map([['docs/new-idea.md', 12]]),
    });

    // Synthesized into its real place in the tree, under `docs/`.
    const row = screen
      .getByTitle('Proposed by you: opens the change request')
      .closest('button')!;
    expect(row).toHaveTextContent('new-idea.md');
    expect(row.className).toContain('text-accent');

    // The click opens the SHARED change-request dialog — there is no content
    // on this branch to open.
    fireEvent.click(row);
    expect(
      await screen.findByRole('dialog', { name: /Change request: Suggested change/ }),
    ).toBeInTheDocument();
  });

  /**
   * "Not in the tree" is ambiguous: new on the suggestions branch, or FILTERED
   * by the server (.bevelignore, read gates). The overlay may only resurrect
   * the first — a proposal under a hidden root folder must not conjure that
   * folder back into the sidebar.
   */
  it('does not synthesize a row under a root folder the server hid', () => {
    renderExplorer({
      fileTree: TREE,
      // `Plugins` is not in TREE — the server filtered it (bevelignored). The
      // touched file underneath must NOT appear.
      minePaths: new Map([['Plugins/newsletter/SKILL.md', 12]]),
    });
    expect(screen.queryByTitle('Proposed by you: opens the change request')).toBeNull();
    expect(screen.queryByText('Plugins')).toBeNull();
    expect(screen.queryByText('SKILL.md')).toBeNull();
  });

  it('keeps a file that exists on the branch as a normal row even when my request touches it', () => {
    renderExplorer({
      fileTree: TREE,
      minePaths: new Map([['brief.md', 12]]),
    });

    // Not synthesized, not recoloured — the branch's own file wins, and the
    // open-request signal for it stays the amber dot (asserted above).
    expect(screen.queryByTitle('Proposed by you: opens the change request')).toBeNull();
    const row = screen.getByText('brief.md').closest('button')!;
    expect(row.className).not.toContain('text-accent');
    // A normal row opens the FILE, never the dialog.
    fireEvent.click(row);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  /**
   * A proposed-only file's access lives where the file does: on the change
   * request's branch. Its right-click offers Manage access, and the sheet is
   * handed that request — never the viewed branch, where the file is absent.
   */
  it('opens Manage access on a proposed-only file against its change request', () => {
    renderExplorer({
      fileTree: TREE,
      minePaths: new Map([['docs/new-idea.md', 12]]),
    });

    const row = screen.getByTitle('Proposed by you: opens the change request').closest('button')!;
    fireEvent.contextMenu(row, { clientX: 40, clientY: 40 });

    // Only what applies to a file this branch does not have.
    expect(screen.queryByRole('menuitem', { name: /Rename/i })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: /Delete/i })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: /Download/i })).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: /Manage access/i }));

    const dialog = screen.getByTestId('manage-access-dialog');
    expect(dialog.dataset.path).toBe('docs/new-idea.md');
    expect(JSON.parse(dialog.dataset.proposal!)).toEqual({
      number: 12,
      branch: 'suggestions/me/knowledge',
    });
  });

  it('keeps an existing file on the viewed branch even when my request modifies it', () => {
    renderExplorer({
      fileTree: TREE,
      minePaths: new Map([['brief.md', 12]]),
    });

    fireEvent.contextMenu(screen.getByText('brief.md'), { clientX: 40, clientY: 40 });
    fireEvent.click(screen.getByRole('menuitem', { name: /Manage access/i }));

    const dialog = screen.getByTestId('manage-access-dialog');
    expect(dialog.dataset.path).toBe('brief.md');
    // No proposal, no pinned workspace: the ambient branch, exactly as before.
    expect(JSON.parse(dialog.dataset.proposal!)).toBeNull();
    expect(dialog.dataset.workspace).toBe('');
  });

  /**
   * An inherited grant on a proposed file was read on the request's branch, so
   * following it to the folder keeps editing there — the folder path alone
   * would resolve to the viewed branch.
   */
  it('keeps the change request when a proposed file retargets to its folder', () => {
    renderExplorer({
      fileTree: TREE,
      minePaths: new Map([['docs/new-idea.md', 12]]),
    });

    const row = screen.getByTitle('Proposed by you: opens the change request').closest('button')!;
    fireEvent.contextMenu(row, { clientX: 40, clientY: 40 });
    fireEvent.click(screen.getByRole('menuitem', { name: /Manage access/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Manage docs →' }));

    const dialog = screen.getByTestId('manage-access-dialog');
    expect(dialog.dataset.path).toBe('docs');
    expect(JSON.parse(dialog.dataset.proposal!)).toEqual({
      number: 12,
      branch: 'suggestions/me/knowledge',
    });
  });

  it('retargets an ordinary file to its folder on the viewed branch', () => {
    renderExplorer({ fileTree: TREE });

    fireEvent.contextMenu(screen.getByText('brief.md'), { clientX: 40, clientY: 40 });
    fireEvent.click(screen.getByRole('menuitem', { name: /Manage access/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Manage docs →' }));

    const dialog = screen.getByTestId('manage-access-dialog');
    expect(dialog.dataset.path).toBe('docs');
    expect(JSON.parse(dialog.dataset.proposal!)).toBeNull();
  });

  it('forgets a retargeted change request on the next right-click', () => {
    renderExplorer({
      fileTree: TREE,
      minePaths: new Map([['docs/new-idea.md', 12]]),
    });

    const row = screen.getByTitle('Proposed by you: opens the change request').closest('button')!;
    fireEvent.contextMenu(row, { clientX: 40, clientY: 40 });
    fireEvent.click(screen.getByRole('menuitem', { name: /Manage access/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Manage docs →' }));

    // A fresh right-click on an ordinary file is a new sheet on the viewed branch.
    fireEvent.contextMenu(screen.getByText('brief.md'), { clientX: 40, clientY: 40 });
    fireEvent.click(screen.getByRole('menuitem', { name: /Manage access/i }));

    const dialog = screen.getByTestId('manage-access-dialog');
    expect(dialog.dataset.path).toBe('brief.md');
    expect(JSON.parse(dialog.dataset.proposal!)).toBeNull();
  });
});

// ── The right-click menu has to land on screen ──
//
// The panel is `position: fixed`, so whatever falls past the bottom edge of
// the window is unreachable: the page will not scroll to a fixed box, and the
// wheel scrolls the tree out from under a menu that stays where it was. A
// folder's menu is nine rows, so pinning it to the raw pointer put `Manage
// access`, `Rename` and `Delete` below the fold for any right-click in the
// lower quarter of the sidebar.
/** jsdom's own viewport, read at import before any test has stubbed it. */
const REAL_VIEWPORT = { width: window.innerWidth, height: window.innerHeight };

describe('FileExplorer right-click: the menu stays inside the window', () => {
  const TREE: FileTreeEntry = {
    name: '.',
    relativePath: '.',
    type: 'directory',
    children: [
      { name: 'reports', relativePath: 'reports', type: 'directory', children: [] },
      { name: 'brief.md', relativePath: 'brief.md', type: 'file' },
    ],
  };

  const MENU_W = 200;
  const MENU_H = 300;

  // jsdom lays nothing out, so every `offsetWidth`/`offsetHeight` is 0 and the
  // placement would have nothing to react to. Give a size to the one element
  // the hook measures: the fixed wrapper, identified by the `role="menu"`
  // panel it holds.
  const isMenuBox = (el: HTMLElement) => el.firstElementChild?.getAttribute('role') === 'menu';
  let restoreLayout: (() => void) | null = null;

  function stubViewport(width: number, height: number) {
    const w = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')!;
    const h = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')!;
    // jsdom defines these as own accessors on `window`, so the descriptor is
    // real and putting it back restores the getter rather than freezing a
    // number in its place.
    const iw = Object.getOwnPropertyDescriptor(window, 'innerWidth')!;
    const ih = Object.getOwnPropertyDescriptor(window, 'innerHeight')!;
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      get(this: HTMLElement) {
        return isMenuBox(this) ? MENU_W : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get(this: HTMLElement) {
        return isMenuBox(this) ? MENU_H : 0;
      },
    });
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
    Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: height });
    restoreLayout = () => {
      Object.defineProperty(HTMLElement.prototype, 'offsetWidth', w);
      Object.defineProperty(HTMLElement.prototype, 'offsetHeight', h);
      Object.defineProperty(window, 'innerWidth', iw);
      Object.defineProperty(window, 'innerHeight', ih);
    };
  }

  /** The fixed wrapper the placement writes to: the `role="menu"` panel's parent. */
  const menuBox = () => screen.getByRole('menu').parentElement as HTMLElement;

  beforeEach(() => {
    cleanup();
    mockAuthFetch.mockReset();
  });

  afterEach(() => {
    restoreLayout?.();
    restoreLayout = null;
  });

  it('flips a folder menu above the pointer when it would run off the bottom', () => {
    stubViewport(1280, 800);
    renderExplorer({ fileTree: TREE });

    fireEvent.contextMenu(screen.getByText('reports'), { clientX: 120, clientY: 760 });

    // Above the pointer, with the 4px gap that keeps the cursor off the last
    // row: 760 - 4 - 300. Without the gap the pointer would come to rest on
    // `Delete`, which is exactly the row it should not be resting on.
    const box = menuBox();
    expect(box.style.top).toBe('456px');
    expect(parseInt(box.style.top, 10) + MENU_H).toBeLessThanOrEqual(window.innerHeight);
  });

  it('keeps every row of a folder menu reachable, Manage access included', () => {
    stubViewport(1280, 800);
    renderExplorer({ fileTree: TREE });

    fireEvent.contextMenu(screen.getByText('reports'), { clientX: 120, clientY: 780 });

    // The impact line, asserted: the row that is the only route to a folder's
    // access control has to be inside the window, not merely rendered.
    expect(screen.getByRole('menuitem', { name: /Manage access/i })).toBeInTheDocument();
    const top = parseInt(menuBox().style.top, 10);
    expect(top).toBeGreaterThanOrEqual(8);
    expect(top + MENU_H).toBeLessThanOrEqual(window.innerHeight - 8);
  });

  it('leaves a menu that already fits where the pointer put it', () => {
    stubViewport(1280, 800);
    renderExplorer({ fileTree: TREE });

    fireEvent.contextMenu(screen.getByText('brief.md'), { clientX: 120, clientY: 100 });

    // Down and to the right of the pointer is what every desktop shell does,
    // and it leaves the cursor on the first row, which is never destructive.
    const box = menuBox();
    expect(box.style.top).toBe('100px');
    expect(box.style.left).toBe('120px');
  });

  it('clamps to the top margin when the window is shorter than the menu', () => {
    stubViewport(1280, 250);
    renderExplorer({ fileTree: TREE });

    fireEvent.contextMenu(screen.getByText('reports'), { clientX: 120, clientY: 200 });

    // Neither side fits, so the panel keeps its top rows rather than losing
    // both ends.
    expect(menuBox().style.top).toBe('8px');
  });

  it('re-places an open menu when the window is resized under it', () => {
    stubViewport(1280, 800);
    renderExplorer({ fileTree: TREE });

    // Opens with room to spare, so the menu sits at the pointer.
    fireEvent.contextMenu(screen.getByText('reports'), { clientX: 120, clientY: 400 });
    expect(menuBox().style.top).toBe('400px');

    // Shrink the window with the menu still open. Dragging a window edge would
    // have closed it, since that is a mousedown outside the panel, but zoom,
    // fullscreen and OS window snapping resize without one.
    act(() => {
      Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 500 });
      window.dispatchEvent(new Event('resize'));
    });

    // 400 + 300 no longer fits under 500, and 400 - 4 - 300 clears the margin,
    // so it flips rather than hanging off the bottom of the new viewport.
    expect(menuBox().style.top).toBe('96px');
  });

  it('pulls the menu back from the right edge of the window', () => {
    stubViewport(300, 800);
    renderExplorer({ fileTree: TREE });

    fireEvent.contextMenu(screen.getByText('brief.md'), { clientX: 250, clientY: 100 });

    // 300 - 200 - 8: the whole panel, not just its left edge, is on screen.
    expect(menuBox().style.left).toBe('92px');
  });
});

// The stub above is only safe if it puts the window back. A viewport left at
// the last case's 300px would silently narrow whatever runs next, including a
// block someone appends below this one.
describe('FileExplorer right-click: the viewport stub cleans up after itself', () => {
  it('leaves window.innerWidth and innerHeight as it found them', () => {
    expect(window.innerWidth).toBe(REAL_VIEWPORT.width);
    expect(window.innerHeight).toBe(REAL_VIEWPORT.height);
  });
});

// Delete asked nothing and a drop moved a file into another folder without a
// word about what that means. Both now ask first — and a move says that access
// follows the destination, plus whatever else about it is worth knowing.
describe('FileExplorer: delete and move ask first', () => {
  const DRAG_MIME = 'application/x-workspace-path';
  const KB = 'knowledge-base';
  const TREE: FileTreeEntry = {
    name: '.',
    relativePath: '.',
    type: 'directory',
    children: [
      {
        name: KB,
        relativePath: KB,
        type: 'directory',
        children: [
          {
            name: 'KnowledgeBase',
            relativePath: `${KB}/KnowledgeBase`,
            type: 'directory',
            children: [
              {
                name: 'Legal',
                relativePath: `${KB}/KnowledgeBase/Legal`,
                type: 'directory',
                children: [
                  { name: 'contract.pdf', relativePath: `${KB}/KnowledgeBase/Legal/contract.pdf`, type: 'file' },
                  { name: 'access.md', relativePath: `${KB}/KnowledgeBase/Legal/access.md`, type: 'file' },
                  {
                    name: 'Old',
                    relativePath: `${KB}/KnowledgeBase/Legal/Old`,
                    type: 'directory',
                    children: [
                      { name: 'nda.md', relativePath: `${KB}/KnowledgeBase/Legal/Old/nda.md`, type: 'file' },
                    ],
                  },
                ],
              },
              { name: 'Sales', relativePath: `${KB}/KnowledgeBase/Sales`, type: 'directory', children: [] },
            ],
          },
          { name: 'Data', relativePath: `${KB}/Data`, type: 'directory', children: [] },
        ],
      },
    ],
  };
  const CONTRACT = `${KB}/KnowledgeBase/Legal/contract.pdf`;

  beforeEach(() => {
    cleanup();
    mockAuthFetch.mockReset();
  });
  // The branch model is module-global; put back what the shared test setup
  // applied, so a case that protects `main` does not leak into the next suite.
  afterEach(() => {
    configureBranchModel({
      defaultBranch: 'target-company-state',
      protectedBranches: ['current-company-state', 'target-company-state'],
    });
  });

  /** Open Legal so its rows render (Knowledge's children start collapsed). */
  function openLegal() {
    fireEvent.click(screen.getByText('Legal'));
  }

  async function dropOn(rowName: string, sourcePath: string) {
    await act(async () => {
      fireEvent.drop(screen.getByText(rowName), {
        dataTransfer: { getData: (t: string) => (t === DRAG_MIME ? sourcePath : ''), files: [] },
      });
    });
  }

  async function chooseDelete(rowName: string) {
    fireEvent.contextMenu(screen.getByText(rowName));
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: /Delete/i }));
    });
  }

  describe('delete', () => {
    it('names the file and deletes it on Confirm', async () => {
      const { deleteEntry } = renderExplorer({ fileTree: TREE });
      openLegal();
      await chooseDelete('contract.pdf');
      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveTextContent('Delete contract.pdf?');
      expect(deleteEntry).not.toHaveBeenCalled();
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
      });
      expect(deleteEntry).toHaveBeenCalledWith(CONTRACT);
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('counts every file under a folder, nested ones included', async () => {
      renderExplorer({ fileTree: TREE });
      await chooseDelete('Legal');
      expect(screen.getByRole('dialog')).toHaveTextContent('Delete Legal and its 3 files?');
    });

    it('deletes nothing on Cancel', async () => {
      const { deleteEntry } = renderExplorer({ fileTree: TREE });
      await chooseDelete('Sales');
      expect(screen.getByRole('dialog')).toHaveTextContent('Delete Sales and its 0 files?');
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      });
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(deleteEntry).not.toHaveBeenCalled();
    });
  });

  describe('move', () => {
    it('states that access follows the destination, and moves on Confirm', async () => {
      const { moveEntry } = renderExplorer({ fileTree: TREE });
      await dropOn('Sales', CONTRACT);
      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveTextContent(
        "Move contract.pdf to Sales? Access to it will follow Sales' rules from now on.",
      );
      // A move between two folders of the same root, on a draft: nothing else to say.
      expect(screen.queryAllByRole('note')).toHaveLength(0);
      expect(moveEntry).not.toHaveBeenCalled();
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Move' }));
      });
      expect(moveEntry).toHaveBeenCalledWith(CONTRACT, `${KB}/KnowledgeBase/Sales/contract.pdf`);
    });

    it("uses 's for a destination that does not end in s", async () => {
      renderExplorer({ fileTree: TREE });
      openLegal();
      await dropOn('Old', CONTRACT);
      expect(screen.getByRole('dialog')).toHaveTextContent("Access to it will follow Old's rules from now on.");
    });

    it('sends nothing on Cancel', async () => {
      const { moveEntry } = renderExplorer({ fileTree: TREE });
      await dropOn('Sales', CONTRACT);
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      });
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(moveEntry).not.toHaveBeenCalled();
      expect(mockAuthFetch).not.toHaveBeenCalled();
    });

    it('drops an open confirmation when the workspace changes under it', async () => {
      const { moveEntry, switchWorkspace } = renderExplorer({ fileTree: TREE, workspaceId: 'draft-a' });
      await dropOn('Sales', CONTRACT);
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      await act(async () => {
        switchWorkspace('draft-b');
      });
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      // Nor does switching back resurrect it.
      await act(async () => {
        switchWorkspace('draft-a');
      });
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(moveEntry).not.toHaveBeenCalled();
    });

    it('does nothing on a drop onto the folder the entry is already in', async () => {
      const { moveEntry } = renderExplorer({ fileTree: TREE });
      await dropOn('Legal', CONTRACT);
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(moveEntry).not.toHaveBeenCalled();
    });

    it('warns that a platform-managed file is read differently once moved', async () => {
      renderExplorer({ fileTree: TREE });
      await dropOn('Sales', `${KB}/KnowledgeBase/Legal/access.md`);
      expect(screen.getByRole('note')).toHaveTextContent(
        'access.md is a platform-managed file; moving it changes how the platform reads it.',
      );
    });

    it('warns when the move crosses from one root into another', async () => {
      renderExplorer({ fileTree: TREE });
      await dropOn('Data', CONTRACT);
      expect(screen.getByRole('note')).toHaveTextContent(
        'This moves it out of KnowledgeBase/ into Data/ — the two roots are handled differently.',
      );
    });

    it('warns that a move into a folder the caller cannot write will be refused', async () => {
      configureBranchModel({ defaultBranch: 'main', protectedBranches: ['main'] });
      mockAuthFetch.mockResolvedValue({ ok: true, json: async () => ({ canWrite: false }) });
      renderExplorer({ fileTree: TREE, workspaceId: 'main' });
      await dropOn('Sales', CONTRACT);
      expect(await screen.findByRole('note')).toHaveTextContent(
        "You can't write to Sales — the move will be refused.",
      );
      // The lookup is the folder's, repo-relative — what the access route resolves.
      expect(String(mockAuthFetch.mock.calls[0][0])).toContain(
        `/api/workspace/main/access?path=${encodeURIComponent('KnowledgeBase/Sales')}&kind=folder`,
      );
    });

    it('adds no refusal warning when the caller can write the destination', async () => {
      configureBranchModel({ defaultBranch: 'main', protectedBranches: ['main'] });
      mockAuthFetch.mockResolvedValue({ ok: true, json: async () => ({ canWrite: true }) });
      renderExplorer({ fileTree: TREE, workspaceId: 'main' });
      await dropOn('Sales', CONTRACT);
      await waitFor(() => expect(mockAuthFetch).toHaveBeenCalled());
      expect(screen.queryAllByRole('note')).toHaveLength(0);
    });
  });

  describe('keyboard', () => {
    it('confirms on Enter and moves focus to the row it was dropped on', async () => {
      const { moveEntry } = renderExplorer({ fileTree: TREE });
      openLegal();
      // The dragged row leaves the tree once the move lands; the target stays.
      const row = screen.getByText('Sales').closest('button')!;
      await dropOn('Sales', CONTRACT);
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Move' }));
      await act(async () => {
        fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
      });
      expect(moveEntry).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(document.activeElement).toBe(row);
    });

    it('cancels on Escape and returns focus to the row', async () => {
      const { deleteEntry } = renderExplorer({ fileTree: TREE });
      openLegal();
      const row = screen.getByText('contract.pdf').closest('button')!;
      await chooseDelete('contract.pdf');
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      await act(async () => {
        fireEvent.keyDown(document, { key: 'Escape' });
      });
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(deleteEntry).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(row);
    });

    it('returns focus to the containing folder after a confirmed delete', async () => {
      const { deleteEntry } = renderExplorer({ fileTree: TREE });
      openLegal();
      const folder = screen.getByText('Legal').closest('button')!;
      await chooseDelete('contract.pdf');
      await act(async () => {
        fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
      });
      expect(deleteEntry).toHaveBeenCalledWith(CONTRACT);
      expect(document.activeElement).toBe(folder);
    });

    it('lets Enter press Cancel when Cancel has focus', async () => {
      const { deleteEntry } = renderExplorer({ fileTree: TREE });
      await chooseDelete('Sales');
      const cancel = screen.getByRole('button', { name: 'Cancel' });
      cancel.focus();
      await act(async () => {
        fireEvent.keyDown(cancel, { key: 'Enter' });
      });
      expect(deleteEntry).not.toHaveBeenCalled();
    });
  });
});

// A folder holding files proposed in open change requests. Its delete used to
// ask the plain question, count the proposed rows as files it would take, and
// leave them behind: the folder came straight back holding only the proposed
// rows, and deleting THAT reached the server for a path the branch did not
// have. The dialog now names the requests and asks what to do with them.
describe('FileExplorer: deleting a folder with proposed files', () => {
  const KB = 'knowledge-base';
  const REPORTS = `${KB}/Data/Reports`;
  const PROPOSED = `${REPORTS}/proposed.md`;
  /** One committed file on the branch; `proposed.md` exists only in request #12. */
  const TREE: FileTreeEntry = {
    name: '.',
    relativePath: '.',
    type: 'directory',
    children: [
      {
        name: KB,
        relativePath: KB,
        type: 'directory',
        children: [
          {
            name: 'Data',
            relativePath: `${KB}/Data`,
            type: 'directory',
            children: [
              {
                name: 'Reports',
                relativePath: REPORTS,
                type: 'directory',
                children: [{ name: 'committed.md', relativePath: `${REPORTS}/committed.md`, type: 'file' }],
              },
            ],
          },
        ],
      },
    ],
  };
  /** The branch after "Delete folder only": the folder is gone, the proposal is not. */
  const TREE_WITHOUT_REPORTS: FileTreeEntry = {
    ...TREE,
    children: [
      { name: KB, relativePath: KB, type: 'directory', children: [{ name: 'Data', relativePath: `${KB}/Data`, type: 'directory', children: [] }] },
    ],
  };

  const request = (over: Record<string, unknown> = {}) => ({
    number: 12,
    title: 'Quarterly numbers',
    authorName: 'Razvan',
    mine: true,
    paths: ['Data/Reports/proposed.md'],
    mayRemove: true,
    ...over,
  });
  const json = (body: unknown, status = 200) => ({
    ok: status < 400,
    status,
    json: async () => body,
  });

  const removal = (over: Record<string, unknown> = {}) => ({
    number: 12,
    removedPaths: ['Data/Reports/proposed.md'],
    withdrawn: true,
    stillProposed: [],
    keptForSaves: false,
    ...over,
  });

  function answer(requests: unknown[], results: unknown[] = [removal()]) {
    mockAuthFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/workflow/change-requests/under-folder?')) return json({ requests });
      if (url === '/api/workflow/change-requests/under-folder/remove' && init?.method === 'POST') {
        return json({ results });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
  }

  const renderWithProposal = (fileTree: FileTreeEntry = TREE) =>
    renderExplorer({
      fileTree,
      minePaths: new Map([[PROPOSED, 12]]),
      openChangeRequestPaths: [PROPOSED],
    });

  async function chooseDelete(rowName: string) {
    fireEvent.contextMenu(screen.getByText(rowName));
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: /Delete/i }));
    });
  }

  let alertSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    cleanup();
    mockAuthFetch.mockReset();
    alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
  });
  afterEach(() => {
    alertSpy.mockRestore();
  });

  it('names the open requests and offers the three actions, counting only the files on this branch', async () => {
    answer([request()]);
    renderWithProposal();
    await chooseDelete('Reports');
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(dialog).toHaveTextContent('#12 “Quarterly numbers” by you (1 proposed file)'));
    expect(dialog).toHaveTextContent('Delete Reports and its 1 file?');
    expect(mockAuthFetch).toHaveBeenCalledWith('/api/workflow/change-requests/under-folder?path=Data%2FReports');
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Delete folder only' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Delete folder and its proposed changes' })).toBeEnabled();
  });

  it('"Delete folder only" deletes the branch copy and leaves the requests alone', async () => {
    answer([request()]);
    const retracted = vi.fn();
    window.addEventListener('bevel:suggestions-retracted', retracted);
    const { deleteEntry } = renderWithProposal();
    try {
      await chooseDelete('Reports');
      const onlyFolder = await screen.findByRole('button', { name: 'Delete folder only' });
      await act(async () => {
        fireEvent.click(onlyFolder);
      });
      expect(deleteEntry).toHaveBeenCalledWith(REPORTS);
      expect(mockAuthFetch).not.toHaveBeenCalledWith(
        '/api/workflow/change-requests/under-folder/remove',
        expect.anything(),
      );
      // The requests stay open, so their proposed rows stay listed.
      expect(retracted).not.toHaveBeenCalled();
      expect(alertSpy).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('bevel:suggestions-retracted', retracted);
    }
  });

  it('"Delete folder and its proposed changes" deletes the branch copy, then empties the requests, then clears the markers', async () => {
    answer([request()]);
    const events: string[] = [];
    const onRetract = (e: Event) =>
      events.push(`retract:${(e as CustomEvent<{ folder: string }>).detail.folder}`);
    const onStale = () => events.push('stale');
    window.addEventListener('bevel:suggestions-retracted', onRetract);
    window.addEventListener('bevel:pr-stale', onStale);
    const deleteEntry = vi.fn(async () => {
      events.push('delete');
    });
    renderExplorer({
      fileTree: TREE,
      deleteEntry,
      minePaths: new Map([[PROPOSED, 12]]),
      openChangeRequestPaths: [PROPOSED],
    });
    try {
      await chooseDelete('Reports');
      const both = await screen.findByRole('button', { name: 'Delete folder and its proposed changes' });
      await waitFor(() => expect(both).toBeEnabled());
      await act(async () => {
        fireEvent.click(both);
      });
      await waitFor(() => expect(events).toContain('stale'));
      expect(deleteEntry).toHaveBeenCalledWith(REPORTS);
      const removeCall = mockAuthFetch.mock.calls.find(
        ([url]) => url === '/api/workflow/change-requests/under-folder/remove',
      );
      expect(JSON.parse((removeCall?.[1] as RequestInit).body as string)).toEqual({ path: 'Data/Reports' });
      // Branch first, requests second, markers last.
      expect(events).toEqual(['delete', 'retract:Data/Reports', 'stale']);
      expect(alertSpy).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('bevel:suggestions-retracted', onRetract);
      window.removeEventListener('bevel:pr-stale', onStale);
    }
  });

  it('says what the removal left behind: a file proposed meanwhile, a request kept open for a save still landing', async () => {
    answer(
      [request(), request({ number: 40, mine: false, authorName: 'Ana', paths: ['Data/Reports/q3.md'] })],
      [
        removal({ withdrawn: false, stillProposed: ['Data/Reports/notes.md'] }),
        removal({ number: 40, removedPaths: ['Data/Reports/q3.md'], withdrawn: false, keptForSaves: true }),
      ],
    );
    renderWithProposal();
    await chooseDelete('Reports');
    const both = await screen.findByRole('button', { name: 'Delete folder and its proposed changes' });
    await waitFor(() => expect(both).toBeEnabled());
    await act(async () => {
      fireEvent.click(both);
    });
    await waitFor(() => expect(alertSpy).toHaveBeenCalledTimes(1));
    const message = String(alertSpy.mock.calls[0]![0]);
    expect(message).toContain('Deleted Reports and its proposed changes, except:');
    expect(message).toContain('#12 still proposes Data/Reports/notes.md — added while the folder was being deleted.');
    expect(message).toContain('#40 stays open: a save to it was still landing.');
  });

  it('does not touch the requests when the branch delete was called off', async () => {
    answer([request()]);
    const deleteEntry = vi.fn().mockResolvedValue(false);
    renderExplorer({
      fileTree: TREE,
      deleteEntry,
      minePaths: new Map([[PROPOSED, 12]]),
      openChangeRequestPaths: [PROPOSED],
    });
    await chooseDelete('Reports');
    const both = await screen.findByRole('button', { name: 'Delete folder and its proposed changes' });
    await act(async () => {
      fireEvent.click(both);
    });
    expect(deleteEntry).toHaveBeenCalled();
    expect(mockAuthFetch).not.toHaveBeenCalledWith(
      '/api/workflow/change-requests/under-folder/remove',
      expect.anything(),
    );
  });

  it('disables the second action with the reason when one request is not the caller’s to change', async () => {
    answer([
      request(),
      request({
        number: 40,
        title: 'Colleague draft',
        authorName: 'Ana',
        mine: false,
        paths: ['Data/Reports/q3.md'],
        mayRemove: false,
        reason: '#40 was proposed by Ana; only its author, an admin or someone who can write every file it proposes here can change it.',
      }),
    ]);
    renderWithProposal();
    await chooseDelete('Reports');
    const both = await screen.findByRole('button', { name: 'Delete folder and its proposed changes' });
    expect(both).toBeDisabled();
    expect(screen.getByRole('note')).toHaveTextContent('#40 was proposed by Ana');
    expect(screen.getByRole('dialog')).toHaveTextContent('#40 “Colleague draft” by Ana (1 proposed file)');
    expect(screen.getByRole('button', { name: 'Delete folder only' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
  });

  it('never reaches the server for a folder that only proposed files put in the tree (the reproduction case)', async () => {
    answer([request()]);
    const { deleteEntry } = renderWithProposal(TREE_WITHOUT_REPORTS);
    // The proposal alone keeps the folder in the tree.
    await chooseDelete('Reports');
    const onlyFolder = await screen.findByRole('button', { name: 'Delete folder only' });
    expect(screen.getByRole('dialog')).toHaveTextContent('Delete Reports and its 0 files?');
    await act(async () => {
      fireEvent.click(onlyFolder);
    });
    expect(deleteEntry).not.toHaveBeenCalled();
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('opens the plain delete at once for a folder no request touches, and keeps it when the check agrees', async () => {
    answer([]);
    renderExplorer({ fileTree: TREE });
    await chooseDelete('Reports');
    expect(screen.getByRole('dialog')).toHaveTextContent('Delete Reports and its 1 file?');
    expect(screen.getByRole('button', { name: 'Delete' })).toBeEnabled();
    await waitFor(() =>
      expect(mockAuthFetch).toHaveBeenCalledWith('/api/workflow/change-requests/under-folder?path=Data%2FReports'),
    );
    expect(screen.getByRole('button', { name: 'Delete' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Delete folder only' })).not.toBeInTheDocument();
  });

  it('still asks about proposals when the shared request list has not shown any (loading or failed)', async () => {
    answer([request()]);
    // No proposed paths in the shared list, yet the server knows of #12.
    renderExplorer({ fileTree: TREE });
    await chooseDelete('Reports');
    expect(await screen.findByRole('button', { name: 'Delete folder and its proposed changes' })).toBeEnabled();
    expect(screen.getByRole('dialog')).toHaveTextContent('#12 “Quarterly numbers” by you (1 proposed file)');
  });

  it('says nothing about a failed check for a folder the shared list shows no proposals under', async () => {
    mockAuthFetch.mockResolvedValue(json({ error: 'boom' }, 500));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      renderExplorer({ fileTree: TREE });
      await chooseDelete('Reports');
      await waitFor(() => expect(mockAuthFetch).toHaveBeenCalled());
      expect(screen.queryByText(/Couldn't check which change requests/)).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Delete' })).toBeEnabled();
    } finally {
      warn.mockRestore();
    }
  });

  it('still offers the plain delete, with a note, when the requests cannot be checked', async () => {
    mockAuthFetch.mockResolvedValue(json({ error: 'boom' }, 500));
    const { deleteEntry } = renderWithProposal();
    await chooseDelete('Reports');
    await screen.findByText(/Couldn't check which change requests propose files here/);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    });
    expect(deleteEntry).toHaveBeenCalledWith(REPORTS);
  });
});

/**
 * Read is default-deny, so an empty explorer has two causes that look the
 * same: nothing is shared with the caller, or nothing exists yet. The listing
 * root's `withheld` count tells them apart; the explorer says which, and says
 * nothing once a single entry is on screen.
 */
describe('FileExplorer: an empty tree says why', () => {
  const KBD = 'knowledge-base';
  const dirAt = (rel: string, children: FileTreeEntry[] = []): FileTreeEntry => ({
    name: rel.split('/').pop()!,
    relativePath: rel,
    type: 'directory',
    children,
  });
  const fileAt = (rel: string): FileTreeEntry => ({ name: rel.split('/').pop()!, relativePath: rel, type: 'file' });
  /** A seeded knowledge base: the reserved roots, forced visible, with `kb` under KnowledgeBase. */
  const seeded = (kb: FileTreeEntry[], extra: Partial<FileTreeEntry> = {}, loose: FileTreeEntry[] = []): FileTreeEntry => ({
    ...dirAt('.', [
      dirAt(KBD, [
        dirAt(`${KBD}/KnowledgeBase`, kb),
        dirAt(`${KBD}/Plugins`),
        dirAt(`${KBD}/Skills`),
        ...loose,
      ]),
    ]),
    ...extra,
  });

  beforeEach(() => {
    cleanup();
    mockAuthFetch.mockReset();
  });
  afterEach(() => {
    configureBranchModel({
      defaultBranch: 'target-company-state',
      protectedBranches: ['current-company-state', 'target-company-state'],
    });
  });

  it('says nothing is shared when entries were withheld and none are visible', () => {
    renderExplorer({ fileTree: seeded([], { withheld: 12 }) });
    expect(screen.getByTestId('tree-empty-notice')).toHaveTextContent(
      'Nothing here is shared with you yet. Ask an admin to grant you access.',
    );
    expect(screen.queryByText(/This knowledge base is empty/)).not.toBeInTheDocument();
    expect(screen.queryByTestId('tree-empty-create-hint')).not.toBeInTheDocument();
  });

  it('says the knowledge base is empty, with the create hint, when nothing was withheld and the caller may write', () => {
    // A draft branch: writable without asking.
    renderExplorer({ fileTree: seeded([]), workspaceId: 'alice%2Fdraft' });
    const notice = screen.getByTestId('tree-empty-notice');
    expect(notice).toHaveTextContent(/^This knowledge base is empty\./);
    expect(screen.getByTestId('tree-empty-create-hint')).toBeInTheDocument();
    expect(screen.queryByText(/Nothing here is shared/)).not.toBeInTheDocument();
    expect(mockAuthFetch).not.toHaveBeenCalled();
  });

  it('still says "empty" when the only root entry is .bevelignore', () => {
    renderExplorer({ fileTree: seeded([], {}, [fileAt(`${KBD}/.bevelignore`)]), workspaceId: 'alice%2Fdraft' });
    expect(screen.getByTestId('tree-empty-notice')).toHaveTextContent('This knowledge base is empty.');
  });

  it('leaves the create hint out when the caller may not write at the root', async () => {
    mockAuthFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ canWrite: false }) });
    renderExplorer({ fileTree: seeded([]), workspaceId: 'target-company-state' });
    await waitFor(() => expect(mockAuthFetch).toHaveBeenCalled());
    const url = mockAuthFetch.mock.calls[0][0] as string;
    expect(url).toContain('/access?path=KnowledgeBase&kind=folder');
    expect(screen.getByTestId('tree-empty-notice')).toHaveTextContent('This knowledge base is empty.');
    expect(screen.queryByTestId('tree-empty-create-hint')).not.toBeInTheDocument();
  });

  it('asks about the KB clone folder, not the workspace root, for a tree that predates the split', async () => {
    mockAuthFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ canWrite: false }) });
    renderExplorer({ fileTree: dirAt('.', [dirAt(KBD)]), workspaceId: 'target-company-state' });
    await waitFor(() => expect(mockAuthFetch).toHaveBeenCalled());
    expect(mockAuthFetch.mock.calls[0][0] as string).toContain(`/access?path=${KBD}&kind=folder`);
    expect(screen.getByTestId('tree-empty-notice')).toHaveTextContent('This knowledge base is empty.');
    expect(screen.queryByTestId('tree-empty-create-hint')).not.toBeInTheDocument();
  });

  it('shows the create hint on a protected branch once the root is known writable', async () => {
    mockAuthFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ canWrite: true }) });
    renderExplorer({ fileTree: seeded([]), workspaceId: 'target-company-state' });
    expect(await screen.findByTestId('tree-empty-create-hint')).toBeInTheDocument();
  });

  it('shows neither message with one visible entry, withheld or not', () => {
    renderExplorer({ fileTree: seeded([fileAt(`${KBD}/KnowledgeBase/Handbook.md`)], { withheld: 3 }) });
    expect(screen.queryByTestId('tree-empty-notice')).not.toBeInTheDocument();
    cleanup();
    renderExplorer({ fileTree: seeded([dirAt(`${KBD}/KnowledgeBase/Finance`)]) });
    expect(screen.queryByTestId('tree-empty-notice')).not.toBeInTheDocument();
  });

  it('shows nothing while the tree is still loading', () => {
    renderExplorer({ fileTree: null });
    expect(screen.queryByTestId('tree-empty-notice')).not.toBeInTheDocument();
  });
});
