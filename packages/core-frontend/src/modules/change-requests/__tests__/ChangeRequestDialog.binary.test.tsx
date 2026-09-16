import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { PrFileStatus, PullRequestSummary } from '@bevel-software/platform-shared';

/**
 * A document or an image in a change request.
 *
 * The dialog used to answer a proposed pdf, deck or screenshot with one
 * sentence — "there is no text to compare" — and ask its owner to approve
 * bytes nobody had seen. Every one of those formats has a viewer on the file
 * page, and a viewer needs only a workspace id and a path; a branch IS a
 * workspace here. These tests pin what the pane now does: which BRANCH's
 * bytes each case reads, the way back to the current version, the formats
 * that still have no viewer, and the refusal a reader without access gets.
 */

const detailMock = vi.hoisted(() => ({ fetchPrDetail: vi.fn() }));
vi.mock('../../pr/services/pr-detail.api', () => ({ fetchPrDetail: detailMock.fetchPrDetail }));

vi.mock('../services/change-requests.api', () => ({
  readFileOnBranch: vi.fn(async () => 'text'),
}));
vi.mock('../../pr/services/pr-approvals.api', () => ({
  approvePrFile: vi.fn(),
  revertPrFile: vi.fn(),
  unapprovePrFile: vi.fn(),
}));
vi.mock('../../pr/services/pr-merge.api', () => ({ mergePullRequest: vi.fn() }));
vi.mock('../../pr/services/pr-cancel.api', () => ({
  cancelPullRequest: vi.fn(),
  deleteChangeRequest: vi.fn(),
}));

/** The bytes every viewer here fetches go through `authFetch`. */
const apiMock = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('../../../lib/api', () => ({ authFetch: apiMock.authFetch }));

/**
 * Only the bootstrap is stubbed — `rawFileUrl` stays REAL, so the URLs
 * asserted below are the ones the backend actually serves.
 */
const workspaceMock = vi.hoisted(() => ({ getOrCreateWorkspace: vi.fn() }));
vi.mock('../../workspace/services/workspace.api', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getOrCreateWorkspace: workspaceMock.getOrCreateWorkspace,
}));

const accessMock = vi.hoisted(() => ({ fetchFileAccess: vi.fn() }));
vi.mock('../../access/api', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchFileAccess: accessMock.fetchFileAccess,
}));

/**
 * pdf.js needs a worker thread and a real 2D canvas context, neither of which
 * happy-dom has — mocked at the module boundary exactly as `PdfRenderer`'s own
 * test does, so what is under test here stays the dialog's wiring.
 */
const pdfjsMock = vi.hoisted(() => {
  const page = {
    getViewport: vi.fn(({ scale }: { scale: number }) => ({
      width: 600 * scale,
      height: 800 * scale,
    })),
    render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
    cleanup: vi.fn(),
  };
  const doc = {
    numPages: 2,
    getPage: vi.fn(async () => page),
    destroy: vi.fn(async () => {}),
  };
  return {
    getDocument: vi.fn(() => ({ promise: Promise.resolve(doc), destroy: vi.fn(async () => {}) })),
  };
});
vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: {},
  getDocument: pdfjsMock.getDocument,
}));

import { ChangeRequestDialog } from '../components/ChangeRequestDialog';

const CR_BRANCH = 'ali.raza/the-brief';
const TARGET = 'main';
const KB = 'knowledge-base';

/** What `getOrCreateWorkspace` answers with — the workspace id IS the branch. */
const wsId = (branch: string) => encodeURIComponent(branch);

const CR: PullRequestSummary = {
  number: 12,
  title: 'The brief',
  authorId: 'abc',
  author: { login: 'user-abc', name: 'Ali' },
  appAuthor: { name: 'Ali' },
  branch: CR_BRANCH,
  base: TARGET,
  state: 'open',
  createdAt: '2026-08-07T00:00:00.000Z',
  touchedNodePaths: [],
  review: { approvals: 0, changesRequested: 0, pendingLogins: [] },
  url: '/change-requests/12',
} as unknown as PullRequestSummary;

function detailWith(files: { path: string; status: PrFileStatus; previousPath?: string }[]) {
  return {
    ...CR,
    body: '',
    headSha: 'h',
    baseSha: 'b',
    files: files.map((f) => ({
      ...f,
      additions: 0,
      deletions: 0,
      isBinary: true,
      sha: '',
      rawUrl: '',
    })),
    comments: [],
    approvals: files.map((f) => ({
      path: f.path,
      eligibleApprovers: { roles: ['Admin'], users: [] },
      approvedBy: [],
      isApproved: true,
      viewerCanApprove: true,
    })),
    mergeableInBevel: true,
    mergeBlockedReasons: [],
    mergeWarnings: [],
    viewerCanBypassMerge: false,
    viewerCanCancel: false,
  };
}

/** Every raw-file fetch the viewers made, in order. */
const rawUrls = () => apiMock.authFetch.mock.calls.map((c) => String(c[0]));

beforeEach(() => {
  detailMock.fetchPrDetail.mockReset();
  apiMock.authFetch.mockReset();
  apiMock.authFetch.mockResolvedValue({
    ok: true,
    status: 200,
    blob: async () => new Blob(['bytes']),
    arrayBuffer: async () => new ArrayBuffer(8),
  });
  workspaceMock.getOrCreateWorkspace.mockReset();
  workspaceMock.getOrCreateWorkspace.mockImplementation(async (branch: string) => ({
    workspace: { id: wsId(branch), kbDirName: KB },
    fileTree: { name: KB, type: 'directory', children: [] },
  }));
  accessMock.fetchFileAccess.mockReset();
  accessMock.fetchFileAccess.mockResolvedValue({ canRead: true, canDownload: true });
  (globalThis.URL as unknown as { createObjectURL: unknown }).createObjectURL = vi.fn(
    () => 'blob:fake-url',
  );
  (globalThis.URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = vi.fn();
});

describe('ChangeRequestDialog: a proposed document', () => {
  it('renders an added pdf with the file page viewer, reading the request branch', async () => {
    detailMock.fetchPrDetail.mockResolvedValue(
      detailWith([{ path: 'Inbox/brief.pdf', status: 'added' }]),
    );
    render(<ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />);

    // The PDF viewer itself, not a sentence about one.
    expect(await screen.findByText('Page 1 of 2')).toBeInTheDocument();
    expect(screen.queryByText(/There is no text to compare/)).not.toBeInTheDocument();

    // The bytes come from the REQUEST's workspace, under the KB dir.
    await waitFor(() =>
      expect(rawUrls()).toContain(
        `/api/workspace/${wsId(CR_BRANCH)}/file/raw?path=${encodeURIComponent(`${KB}/Inbox/brief.pdf`)}`,
      ),
    );
    expect(screen.getByText('Proposed version')).toBeInTheDocument();
    // Nothing to open: the file does not exist on the target branch.
    expect(screen.queryByRole('link', { name: /Open the current version/ })).toBeNull();
  });

  it('renders a changed image and offers the current version on the target branch', async () => {
    detailMock.fetchPrDetail.mockResolvedValue(
      detailWith([{ path: 'Docs/logo.png', status: 'modified' }]),
    );
    render(<ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />);

    const img = await screen.findByRole('img', { name: `${KB}/Docs/logo.png` });
    expect(img).toHaveAttribute('src', 'blob:fake-url');
    expect(rawUrls()).toContain(
      `/api/workspace/${wsId(CR_BRANCH)}/file/raw?path=${encodeURIComponent(`${KB}/Docs/logo.png`)}`,
    );

    expect(screen.getByText('Proposed version')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /Open the current version/ });
    expect(link).toHaveAttribute('href', `/workspace/${TARGET}/${KB}/Docs/logo.png`);
    // A new tab: leaving the dialog mid-review would lose the review context.
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('shows the CURRENT version of a binary the request does not touch', async () => {
    detailMock.fetchPrDetail.mockResolvedValue(
      detailWith([{ path: 'Docs/note.md', status: 'modified' }]),
    );
    render(
      <ChangeRequestDialog
        cr={CR}
        scope={{ prefix: 'Docs', baseFiles: ['logo.png'] }}
        onClose={() => {}}
        onResolved={() => {}}
      />,
    );

    fireEvent.click(await screen.findByTitle('Docs/logo.png'));

    expect(await screen.findByText('Current version')).toBeInTheDocument();
    expect(screen.queryByText(/No text to show/)).toBeNull();
    // The untouched file's bytes are the TARGET branch's — the request has no
    // version of it to propose.
    await waitFor(() =>
      expect(rawUrls()).toContain(
        `/api/workspace/${wsId(TARGET)}/file/raw?path=${encodeURIComponent(`${KB}/Docs/logo.png`)}`,
      ),
    );
    expect(screen.queryByRole('link', { name: /Open the current version/ })).toBeNull();
  });

  it('keeps the note for a format with no viewer, and offers the proposed bytes', async () => {
    detailMock.fetchPrDetail.mockResolvedValue(
      detailWith([{ path: 'Docs/minutes.odt', status: 'added' }]),
    );
    render(<ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />);

    expect(await screen.findByText(/There is no text to compare/)).toBeInTheDocument();
    const download = await screen.findByRole('button', { name: 'Download the proposed file' });

    fireEvent.click(download);
    await waitFor(() =>
      expect(rawUrls()).toContain(
        `/api/workspace/${wsId(CR_BRANCH)}/file/raw?path=${encodeURIComponent(`${KB}/Docs/minutes.odt`)}&download=1`,
      ),
    );
  });

  /**
   * A viewport renderer (pdf, image, workbook) scrolls itself and collapses to
   * 0px without a definite height; a document renderer wants the file page's
   * edged frame instead. The dialog's pane has to hand each the shape it was
   * written for.
   */
  it('gives a viewport viewer a definite height and a document viewer the file frame', async () => {
    detailMock.fetchPrDetail.mockResolvedValue(
      detailWith([{ path: 'Inbox/brief.pdf', status: 'added' }]),
    );
    const pdf = render(<ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />);
    const viewport = await screen.findByTestId('cr-preview-viewport');
    expect(viewport.className).toContain('h-full');
    expect(viewport.className).toContain('min-h-[60vh]');
    expect(screen.queryByTestId('file-pane-card')).toBeNull();
    pdf.unmount();

    detailMock.fetchPrDetail.mockResolvedValue(
      detailWith([{ path: 'Inbox/offer.eml', status: 'added' }]),
    );
    render(<ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />);
    expect(await screen.findByTestId('file-pane-card')).toBeInTheDocument();
    expect(screen.queryByTestId('cr-preview-viewport')).toBeNull();
  });

  /**
   * A DELETION. The request's branch does not have the path at all, so reading
   * it there would 404 into "Failed to load PDF (HTTP 404)"; the document
   * under decision is the one still on the target branch, and the pane has to
   * say that it is the one that would go.
   */
  it('shows a removed binary from the TARGET branch, named as a deletion', async () => {
    detailMock.fetchPrDetail.mockResolvedValue(
      detailWith([{ path: 'Inbox/brief.pdf', status: 'removed' }]),
    );
    render(<ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />);

    expect(await screen.findByText('Page 1 of 2')).toBeInTheDocument();
    expect(await screen.findByText(/This request DELETES this file/)).toBeInTheDocument();
    expect(screen.getByText('Current version')).toBeInTheDocument();

    // The TARGET branch's bytes, and never the request branch's — the path is
    // gone there.
    await waitFor(() =>
      expect(rawUrls()).toContain(
        `/api/workspace/${wsId(TARGET)}/file/raw?path=${encodeURIComponent(`${KB}/Inbox/brief.pdf`)}`,
      ),
    );
    expect(rawUrls().some((u) => u.includes(wsId(CR_BRANCH)))).toBe(false);
    // This pane already IS the current version.
    expect(screen.queryByRole('link', { name: /Open the current version/ })).toBeNull();
  });

  /** A removed format with no viewer hands over the bytes that would go. */
  it('offers the target branch bytes for a removed file no viewer renders', async () => {
    detailMock.fetchPrDetail.mockResolvedValue(
      detailWith([{ path: 'Docs/minutes.odt', status: 'removed' }]),
    );
    render(<ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />);

    expect(await screen.findByText(/this request DELETES/)).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Download the file' }));
    await waitFor(() =>
      expect(rawUrls()).toContain(
        `/api/workspace/${wsId(TARGET)}/file/raw?path=${encodeURIComponent(`${KB}/Docs/minutes.odt`)}&download=1`,
      ),
    );
  });

  /**
   * A RENAMED file's current version is under its OLD name. Pointing the link
   * at the proposed path on the target branch opens a 404 — the target branch
   * has never had the file under that name.
   */
  it('opens a renamed binary current version under its OLD path', async () => {
    detailMock.fetchPrDetail.mockResolvedValue(
      detailWith([
        { path: 'Docs/logo-2026.png', status: 'renamed', previousPath: 'Docs/logo.png' },
      ]),
    );
    render(<ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />);

    // The proposed bytes still come from the request's branch, under the NEW name.
    await screen.findByRole('img', { name: `${KB}/Docs/logo-2026.png` });
    expect(rawUrls()).toContain(
      `/api/workspace/${wsId(CR_BRANCH)}/file/raw?path=${encodeURIComponent(`${KB}/Docs/logo-2026.png`)}`,
    );

    expect(screen.getByText('Proposed version')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open the current version/ })).toHaveAttribute(
      'href',
      `/workspace/${TARGET}/${KB}/Docs/logo.png`,
    );
  });

  /** A rename with no `previousPath` has no current version to point at. */
  it('offers no current-version link for a rename without an old path', async () => {
    detailMock.fetchPrDetail.mockResolvedValue(
      detailWith([{ path: 'Docs/logo-2026.png', status: 'renamed' }]),
    );
    render(<ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />);

    await screen.findByRole('img', { name: `${KB}/Docs/logo-2026.png` });
    expect(screen.getByText('Proposed version')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Open the current version/ })).toBeNull();
  });

  /**
   * A branch that cannot be opened has to be SAID on the download path too.
   * Rendering nothing under a note that promises the bytes reads as a missing
   * button rather than as the branch problem it is.
   */
  it('says so when the branch cannot be opened for a no-viewer download', async () => {
    workspaceMock.getOrCreateWorkspace.mockRejectedValue(new Error('no such branch'));
    detailMock.fetchPrDetail.mockResolvedValue(
      detailWith([{ path: 'Docs/minutes.odt', status: 'added' }]),
    );
    render(<ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />);

    expect(await screen.findByText(/branch couldn't be opened/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Download/ })).toBeNull();
  });

  /**
   * The no-viewer path asks the SAME access question as the viewer pane. It
   * used to ask nothing at all, so a restricted `.zip` offered a live Download
   * that answered a click with a bare "Download failed (HTTP 403)" — the raw
   * endpoint's gate holding, but nothing the file page would ever say.
   */
  it('refuses the no-viewer download when the reader may not read the file', async () => {
    accessMock.fetchFileAccess.mockResolvedValue({ canRead: false, canDownload: false });
    detailMock.fetchPrDetail.mockResolvedValue(
      detailWith([{ path: 'Docs/minutes.odt', status: 'added' }]),
    );
    render(<ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />);

    expect(await screen.findByText("You don't have access to this file")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Download/ })).toBeNull();
    // …and the bytes were never asked for.
    expect(rawUrls()).toHaveLength(0);
  });

  /**
   * Readable but not downloadable: the button stays, disabled, with its
   * reason — `DownloadFileButton`'s own rule, the same one the file page
   * feeds it.
   */
  it('disables the no-viewer download when the reader may not download it', async () => {
    accessMock.fetchFileAccess.mockResolvedValue({ canRead: true, canDownload: false });
    detailMock.fetchPrDetail.mockResolvedValue(
      detailWith([{ path: 'Docs/minutes.odt', status: 'added' }]),
    );
    render(<ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />);

    const download = await screen.findByRole('button', { name: 'Download the proposed file' });
    expect(download).toBeDisabled();
    expect(download).toHaveAttribute(
      'title',
      'You do not have download permission for this file.',
    );
  });

  it('refuses the same way the file page does when the reader may not read it', async () => {
    accessMock.fetchFileAccess.mockResolvedValue({ canRead: false, canDownload: false });
    detailMock.fetchPrDetail.mockResolvedValue(
      detailWith([{ path: 'Board/deck.pptx', status: 'added' }]),
    );
    render(<ChangeRequestDialog cr={CR} onClose={() => {}} onResolved={() => {}} />);

    expect(await screen.findByText("You don't have access to this file")).toBeInTheDocument();
    expect(screen.getByText(/is restricted\. Ask an owner to grant you read access\./)).
      toBeInTheDocument();
    // …and the bytes were never asked for.
    expect(rawUrls()).toHaveLength(0);
  });
});
