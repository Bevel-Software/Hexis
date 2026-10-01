import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type {
  BranchInfo,
  CommitAttribution,
  WorkingTreeStatus,
} from '@bevel-software/platform-shared';

/**
 * A past save shown with the FILE PAGE's viewer.
 *
 * Every assertion here is about the BINDING: the viewer that mounts is the one
 * the file page uses for that extension, and the bytes it reads are the ones
 * of the selected save (`?ref=<sha>`, and `&side=before` where the save
 * deleted the file) rather than the working tree's. Before this, a PNG's or a
 * PDF's history showed git's one-line "Binary files differ".
 */

/** The bytes every viewer here fetches go through `authFetch`. */
const apiMock = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('../../../lib/api', () => ({ authFetch: apiMock.authFetch }));

/** `rawFileUrl` stays REAL, so the URLs asserted below are the served ones. */
const accessMock = vi.hoisted(() => ({ fetchFileAccess: vi.fn() }));
vi.mock('../../access/api', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchFileAccess: accessMock.fetchFileAccess,
}));

/**
 * pdf.js needs a worker thread and a real 2D canvas context, neither of which
 * happy-dom has — mocked at the module boundary exactly as `PdfRenderer`'s own
 * test does, so what is under test stays this pane's wiring.
 */
const pdfjsMock = vi.hoisted(() => {
  const page = {
    getViewport: vi.fn(({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale })),
    render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
    cleanup: vi.fn(),
  };
  const doc = { numPages: 3, getPage: vi.fn(async () => page), destroy: vi.fn(async () => {}) };
  return {
    getDocument: vi.fn(() => ({ promise: Promise.resolve(doc), destroy: vi.fn(async () => {}) })),
  };
});
vi.mock('pdfjs-dist', () => ({ GlobalWorkerOptions: {}, getDocument: pdfjsMock.getDocument }));

const mammothMock = vi.hoisted(() => ({
  convertToHtml: vi.fn(async () => ({ value: '<p>The memo as it was</p>' })),
}));
vi.mock('mammoth/mammoth.browser.js', () => ({ default: mammothMock }));

import { HistoryVersionPreview } from '../components/HistoryVersionPreview';
import { GitContext, type GitContextValue } from '../state/git.context';
import {
  WorkspaceContext,
  type WorkspaceContextValue,
} from '../../workspace/state/workspace.context';

const KB = 'knowledge-base';
const WS = 'target-company-state';
const SHA = '1111111111111111111111111111111111111111';

function makeCommit(partial: Partial<CommitAttribution> = {}): CommitAttribution {
  return {
    sha: SHA,
    authorName: 'Alice',
    authorEmail: 'alice@example.com',
    subject: 'replace the logo',
    committedAt: '2026-04-17T10:00:00Z',
    ...partial,
  };
}

function makeGit(overrides: Partial<GitContextValue> = {}): GitContextValue {
  const status: WorkingTreeStatus = {
    // A PROTECTED branch, so `useFileAccess` really resolves `download:`
    // instead of short-circuiting the way it does on a draft.
    branch: WS,
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

const workspace = { workspaceId: WS, kbDirName: KB } as unknown as WorkspaceContextValue;

/** `repoPath` is repo-relative; the pane takes the workspace-relative form. */
function renderPane(
  repoPath: string,
  git: GitContextValue,
  commit: CommitAttribution = makeCommit(),
) {
  return render(
    <MemoryRouter initialEntries={[`/workspace/${WS}/${KB}/${repoPath}`]}>
      <WorkspaceContext.Provider value={workspace}>
        <GitContext.Provider value={git}>
          <HistoryVersionPreview filePath={`${KB}/${repoPath}`} commit={commit} />
        </GitContext.Provider>
      </WorkspaceContext.Provider>
    </MemoryRouter>,
  );
}

/** Every raw-file fetch the viewers (and the download) made, in order. */
const rawUrls = () => apiMock.authFetch.mock.calls.map((c) => String(c[0]));
const refUrl = (path: string, extra = '') =>
  `/api/workspace/${WS}/file/raw?path=${encodeURIComponent(`${KB}/${path}`)}${extra}&ref=${SHA}`;

/** A patch shaped like the one `git show --format=` produces for a binary. */
const binaryPatch = (name: string) =>
  `diff --git a/${name} b/${name}\nindex 1111111..2222222 100644\nBinary files a/${name} and b/${name} differ\n`;
const deletedBinaryPatch = (name: string) =>
  `diff --git a/${name} b/${name}\ndeleted file mode 100644\nindex 1111111..0000000\nBinary files a/${name} and /dev/null differ\n`;

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
  mammothMock.convertToHtml.mockClear();
  (globalThis.URL as unknown as { createObjectURL: unknown }).createObjectURL = vi.fn(
    () => 'blob:fake-url',
  );
  (globalThis.URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = vi.fn();
});

describe('HistoryVersionPreview — the viewer is bound to the selected save', () => {
  it('heads the pane with the save\'s time and author', async () => {
    renderPane('Docs/logo.png', makeGit({ fetchFileDiff: async () => binaryPatch('Docs/logo.png') }));
    expect(await screen.findByText(/As saved .* by Alice/)).toBeInTheDocument();
  });

  it('shows a PDF save in the PDF viewer, reading that save\'s bytes', async () => {
    renderPane(
      'Docs/Q3-report.pdf',
      makeGit({ fetchFileDiff: async () => binaryPatch('Docs/Q3-report.pdf') }),
    );
    // The viewer itself, not a sentence about binary files.
    expect(await screen.findByText('Page 1 of 3')).toBeInTheDocument();
    expect(screen.queryByText(/Binary files/)).not.toBeInTheDocument();
    await waitFor(() => expect(rawUrls()).toContain(refUrl('Docs/Q3-report.pdf')));
  });

  it('shows a PNG save as the picture it was', async () => {
    renderPane('Docs/logo.png', makeGit({ fetchFileDiff: async () => binaryPatch('Docs/logo.png') }));
    const img = await screen.findByRole('img', { name: `${KB}/Docs/logo.png` });
    expect(img).toHaveAttribute('src', 'blob:fake-url');
    await waitFor(() => expect(rawUrls()).toContain(refUrl('Docs/logo.png')));
    // No `&v=`: a version's bytes cannot change, so the image revision — which
    // bumps on every save of the file — must not key the read.
    expect(rawUrls().some((u) => u.includes('&v='))).toBe(false);
  });

  it('shows a DOCX save through the Word viewer', async () => {
    renderPane('Docs/memo.docx', makeGit({ fetchFileDiff: async () => binaryPatch('Docs/memo.docx') }));
    expect(await screen.findByText('The memo as it was')).toBeInTheDocument();
    await waitFor(() => expect(rawUrls()).toContain(refUrl('Docs/memo.docx')));
  });

  it('renders an HTML save from that save\'s own text, and toggles to the line changes', async () => {
    const patch = '--- a\n+++ b\n@@ -1 +1 @@\n-<p>old</p>\n+<p>new</p>\n';
    renderPane(
      'Pages/landing.html',
      makeGit({
        fetchFileDiff: async () => patch,
        fetchFileAtChange: async () => ({
          baseline: '<p>old</p>',
          current: '<h1>The page as it was</h1>',
        }),
      }),
    );

    // The sandboxed preview, built from the save's text — not the patch.
    const frame = await waitFor(() => {
      const el = document.querySelector('iframe');
      expect(el).not.toBeNull();
      return el as HTMLIFrameElement;
    });
    expect(frame.getAttribute('srcdoc')).toContain('The page as it was');
    expect(screen.queryByText(/\+<p>new<\/p>/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Source changes' }));
    expect(await screen.findByText(/\+<p>new<\/p>/)).toBeInTheDocument();
    expect(document.querySelector('iframe')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await waitFor(() => expect(document.querySelector('iframe')).not.toBeNull());
  });

  it('offers the source toggle for svg and csv, and NOT for a pdf or an image', async () => {
    const { unmount } = renderPane(
      'Docs/chart.svg',
      makeGit({ fetchFileDiff: async () => '--- a\n+++ b\n@@ -1 +1 @@\n-<svg/>\n+<svg />\n' }),
    );
    expect(await screen.findByRole('button', { name: 'Source changes' })).toBeInTheDocument();
    unmount();

    renderPane('Docs/Q3.pdf', makeGit({ fetchFileDiff: async () => binaryPatch('Docs/Q3.pdf') }));
    await screen.findByText('Page 1 of 3');
    expect(screen.queryByRole('button', { name: 'Source changes' })).toBeNull();
  });

  it('shows the note and the version just before the save that deleted the file', async () => {
    renderPane(
      'Docs/old-logo.png',
      makeGit({ fetchFileDiff: async () => deletedBinaryPatch('Docs/old-logo.png') }),
    );
    expect(await screen.findByText('This save deleted the file.')).toBeInTheDocument();
    // …and the image below it, read from the side BEFORE the save.
    await waitFor(() =>
      expect(rawUrls()).toContain(`${refUrl('Docs/old-logo.png')}&side=before`),
    );
    expect(await screen.findByRole('img', { name: `${KB}/Docs/old-logo.png` })).toBeInTheDocument();
  });

  it('names the formats no viewer renders, and still offers the bytes', async () => {
    renderPane(
      'Docs/archive.zip',
      makeGit({ fetchFileDiff: async () => binaryPatch('Docs/archive.zip') }),
    );
    expect(await screen.findByText('No preview for this format.')).toBeInTheDocument();
    const download = screen.getByRole('button', { name: 'Download this version' });
    fireEvent.click(download);
    await waitFor(() =>
      expect(rawUrls()).toContain(
        `/api/workspace/${WS}/file/raw?path=${encodeURIComponent(`${KB}/Docs/archive.zip`)}&download=1&ref=${SHA}`,
      ),
    );
  });

  it('names an unknown binary the same way, on git\'s own word for it', async () => {
    // `.bin` is in no list the app keeps; the patch saying "Binary files …
    // differ" is what makes "and any other binary" true.
    renderPane(
      'Docs/blob.bin',
      makeGit({ fetchFileDiff: async () => binaryPatch('Docs/blob.bin') }),
    );
    expect(await screen.findByText('No preview for this format.')).toBeInTheDocument();
  });

  it('keeps the line changes for a text format with no viewer', async () => {
    renderPane(
      'Docs/notes.txt',
      makeGit({ fetchFileDiff: async () => '--- a\n+++ b\n@@ -1 +1 @@\n-foo\n+bar\n' }),
    );
    expect(await screen.findByText(/\+bar/)).toBeInTheDocument();
    expect(screen.queryByText('No preview for this format.')).toBeNull();
  });

  it('downloads the save\'s bytes, not today\'s', async () => {
    renderPane('Docs/logo.png', makeGit({ fetchFileDiff: async () => binaryPatch('Docs/logo.png') }));
    fireEvent.click(await screen.findByRole('button', { name: 'Download this version' }));
    await waitFor(() =>
      expect(rawUrls()).toContain(
        `/api/workspace/${WS}/file/raw?path=${encodeURIComponent(`${KB}/Docs/logo.png`)}&download=1&ref=${SHA}`,
      ),
    );
  });

  it('disables the download for a reader without download permission, and says why', async () => {
    accessMock.fetchFileAccess.mockResolvedValue({
      canWrite: false,
      canDownload: false,
      eligible: { roles: [], users: [] },
      owners: { roles: [], users: [] },
    });
    renderPane('Docs/logo.png', makeGit({ fetchFileDiff: async () => binaryPatch('Docs/logo.png') }));
    const button = await screen.findByRole('button', { name: 'Download this version' });
    await waitFor(() => expect(button).toBeDisabled());
    expect(button).toHaveAttribute(
      'title',
      'You do not have download permission for this file.',
    );
  });

  it('holds the download idle until it knows which side of the save to read', async () => {
    // Until the patch comes back the pane does not know whether this save
    // DELETED the file, so it does not know whether "this version" is the side
    // after it or the side before it. A click in that window would ask for the
    // after side of a deleting save and get a 404 for a version the reader can
    // see listed.
    let answer: (patch: string) => void = () => {};
    const patch = new Promise<string>((resolve) => {
      answer = resolve;
    });
    renderPane('Docs/old-logo.png', makeGit({ fetchFileDiff: () => patch }));

    const button = await screen.findByRole('button', { name: 'Download this version' });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(rawUrls().some((u) => u.includes('download=1'))).toBe(false);

    answer(deletedBinaryPatch('Docs/old-logo.png'));
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    // …and now it reads the side BEFORE the save, which is the only one with
    // any bytes at all.
    await waitFor(() =>
      expect(rawUrls()).toContain(
        `/api/workspace/${WS}/file/raw?path=${encodeURIComponent(
          `${KB}/Docs/old-logo.png`,
        )}&download=1&ref=${SHA}&side=before`,
      ),
    );
  });

  it('keeps the empty state for a save that did not touch the file', async () => {
    // A save the file's log lists but whose patch is empty for this path (a
    // pure rename elsewhere in the commit): there is no version to show, and a
    // viewer bound to a ref with nothing at it would answer with a read error.
    renderPane('Docs/logo.png', makeGit({ fetchFileDiff: async () => '' }));
    expect(await screen.findByText('No file changes in this save.')).toBeInTheDocument();
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByText('No preview for this format.')).toBeNull();
    // …and no download either: there is no version of this file at that save
    // to hand over, so the button would only ever answer with a 404.
    expect(screen.queryByRole('button', { name: 'Download this version' })).toBeNull();
    // The header still says WHICH save is selected.
    expect(screen.getByText(/As saved .* by Alice/)).toBeInTheDocument();
  });

  it('hands focus to the pane when a viewer\'s own Try again unmounts it', async () => {
    // Pressing "Try again" removes the button from the DOM, so focus would
    // fall to document.body and the next Tab would restart at the top of the
    // page. The viewport the viewer sits in is what survives the swap.
    apiMock.authFetch.mockRejectedValueOnce(new Error('network down'));
    renderPane('Docs/logo.png', makeGit({ fetchFileDiff: async () => binaryPatch('Docs/logo.png') }));

    const retry = await screen.findByRole('button', { name: 'Try again' });
    const pane = screen.getByTestId('history-preview-viewport');
    fireEvent.click(retry);
    expect(document.activeElement).toBe(pane);
    expect(await screen.findByRole('img', { name: `${KB}/Docs/logo.png` })).toBeInTheDocument();
  });

  it('shows the refusal, with Try again, when the version cannot be loaded — never a blank pane', async () => {
    const fetchFileDiff = vi
      .fn()
      .mockRejectedValueOnce(new Error("This version is not in this file's history on this branch."))
      .mockResolvedValue(binaryPatch('Docs/logo.png'));
    renderPane('Docs/logo.png', makeGit({ fetchFileDiff }));

    expect(
      await screen.findByText("This version is not in this file's history on this branch."),
    ).toBeInTheDocument();
    // The header stays: the pane always says which save it is about.
    expect(screen.getByText(/As saved .* by Alice/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('img', { name: `${KB}/Docs/logo.png` })).toBeInTheDocument();
    expect(fetchFileDiff).toHaveBeenCalledTimes(2);
  });

  it('gives a reader who may not read the file the refusal the panel already gave', async () => {
    // The refusal is the BACKEND's: `show-file` 403s a path the caller cannot
    // read, and `friendlyGitError` passes that sentence through. The pane says
    // the same thing the history panel has always said for the same file — and
    // the bytes route refuses too, so nothing renders behind it.
    const denial = 'You don\'t have permission to read "knowledge-base/Docs/logo.png".';
    renderPane(
      'Docs/logo.png',
      makeGit({
        fetchFileDiff: async () => {
          throw new Error(denial);
        },
      }),
    );
    expect(await screen.findByText(denial)).toBeInTheDocument();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('keeps the version on screen when the panel re-renders around it', async () => {
    // A save landing on the file re-renders the panel (the list gains a row)
    // and hands this pane a fresh git object. The viewer must not re-read: the
    // bytes of a commit cannot have changed, and a re-read would blink the
    // document back to its loading state.
    const pngGit = () => makeGit({ fetchFileDiff: async () => binaryPatch('Docs/logo.png') });
    const commit = makeCommit();
    const { rerender } = renderPane('Docs/logo.png', pngGit(), commit);
    await screen.findByRole('img', { name: `${KB}/Docs/logo.png` });
    const readsBefore = rawUrls().length;

    // A WHOLE new git value, fresh method identities and all — which is what
    // the panel really hands over. Spreading the old one would keep every
    // function reference, so the pane's own load effect would not even re-run
    // and the assertion below would hold with no memoization at all.
    rerender(
      <MemoryRouter initialEntries={[`/workspace/${WS}/Docs/logo.png`]}>
        <WorkspaceContext.Provider value={workspace}>
          <GitContext.Provider value={pngGit()}>
            <HistoryVersionPreview filePath={`${KB}/Docs/logo.png`} commit={commit} />
          </GitContext.Provider>
        </WorkspaceContext.Provider>
      </MemoryRouter>,
    );
    expect(await screen.findByRole('img', { name: `${KB}/Docs/logo.png` })).toBeInTheDocument();
    expect(rawUrls().length).toBe(readsBefore);
  });
});

/**
 * The document parsers are code-split (`renderers/index.ts`: pdf.js ~340 KB,
 * xlsx ~141 KB, mammoth ~119 KB). Version history reaches them through the
 * same registry the file page uses, so it must reach them the same way — by
 * the lazy wrapper, never by a static import that would drag the parser into
 * whatever chunk the history panel lands in.
 */
describe('the viewers stay lazily loaded', () => {
  /** Read from the package root, which is vitest's working directory. */
  async function sourceOf(file: string): Promise<string> {
    const { readFileSync } = await import('node:fs');
    return readFileSync(`src/modules/git/${file}`, 'utf8');
  }

  it.each([
    'components/HistoryVersionPreview.tsx',
    'components/FileHistoryPanel.tsx',
  ])('%s imports no parser and no heavy viewer directly', async (file) => {
    const src = await sourceOf(file);
    for (const forbidden of [
      'pdfjs-dist',
      'mammoth',
      'xlsx',
      '/PdfRenderer',
      '/DocxRenderer',
      '/XlsxRenderer',
      '/PptxRenderer',
      '/EmailRenderer',
    ]) {
      expect(src).not.toContain(`from '${forbidden}`);
      expect(src).not.toContain(`import('${forbidden}`);
    }
  });

  it('reaches a viewer through the registry, which is where the laziness lives', async () => {
    expect(await sourceOf('components/HistoryVersionPreview.tsx')).toContain('getFileRenderer');
  });
});
