import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  WorkspaceContext,
  type WorkspaceContextValue,
} from '../../../state/workspace.context';

/**
 * pdf.js is mocked at the module boundary: the real library needs a worker
 * thread and a 2D canvas context, neither of which happy-dom has. What is
 * under test is everything the renderer OWNS — the fetch, the pager, the
 * fit-to-width scale handed to `getViewport`, parse-failure copy, document
 * teardown — against pdf.js's v5 surface (`getDocument().promise`,
 * `doc.getPage`, `page.render({ canvas, viewport })`).
 */
const pdfjsMock = vi.hoisted(() => {
  const renderTask = { promise: Promise.resolve(), cancel: vi.fn() };
  const page = {
    getViewport: vi.fn(({ scale }: { scale: number }) => ({
      width: 600 * scale,
      height: 800 * scale,
    })),
    render: vi.fn(() => renderTask),
    cleanup: vi.fn(),
  };
  const doc = {
    numPages: 3,
    getPage: vi.fn(async (_n: number) => page),
    destroy: vi.fn(async () => {}),
  };
  // The renderer retains the LOADING TASK and destroys that (pdf.js's
  // canonical teardown — it frees the doc in every state); the mock task's
  // destroy forwards to doc.destroy the way the real one does.
  const makeTask = (promise: Promise<unknown>) => ({
    promise,
    destroy: vi.fn(async () => {
      await doc.destroy();
    }),
  });
  return {
    doc,
    page,
    renderTask,
    makeTask,
    getDocument: vi.fn(() => makeTask(Promise.resolve(doc))),
  };
});
vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: {},
  getDocument: pdfjsMock.getDocument,
}));

import { PdfRenderer } from '../PdfRenderer';

const baseProps = {
  filePath: 'Inbox/brief.pdf',
  content: '',
  onSave: async () => {},
};

function renderWithWorkspace(workspaceId: string | null = 'ws-1') {
  return render(
    <WorkspaceContext.Provider
      value={{ workspaceId } as unknown as WorkspaceContextValue}
    >
      <PdfRenderer {...baseProps} />
    </WorkspaceContext.Provider>,
  );
}

function stubPdfFetch() {
  const fetchSpy = vi.fn<typeof fetch>(async () =>
    new Response(new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46])]), { status: 200 }),
  );
  vi.stubGlobal('fetch', fetchSpy);
  return fetchSpy;
}

// happy-dom lays nothing out, so every element measures 0 wide — and the
// renderer deliberately waits for a real measurement before drawing. Give
// the page column a width so fit-to-width has something to fit.
const CONTAINER_WIDTH = 900;

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => CONTAINER_WIDTH,
  });
  pdfjsMock.getDocument.mockClear();
  pdfjsMock.getDocument.mockImplementation(() => pdfjsMock.makeTask(Promise.resolve(pdfjsMock.doc)));
  pdfjsMock.doc.getPage.mockClear();
  pdfjsMock.doc.getPage.mockImplementation(async (_n: number) => pdfjsMock.page);
  pdfjsMock.doc.destroy.mockClear();
  pdfjsMock.page.getViewport.mockClear();
  pdfjsMock.page.render.mockClear();
  pdfjsMock.page.cleanup.mockClear();
});

afterEach(() => {
  delete (HTMLElement.prototype as { clientWidth?: unknown }).clientWidth;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('PdfRenderer', () => {
  it('fetches the bytes, opens the document, and renders page 1 fit to the column width', async () => {
    const fetchSpy = stubPdfFetch();
    renderWithWorkspace('ws-1');

    await screen.findByText('Page 1 of 3');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const calledUrl = String(fetchSpy.mock.calls[0]![0]);
    expect(calledUrl).toContain('/api/workspace/ws-1/file/raw');
    expect(calledUrl).toContain('path=Inbox%2Fbrief.pdf');

    await waitFor(() => expect(pdfjsMock.page.render).toHaveBeenCalledTimes(1));
    expect(pdfjsMock.doc.getPage).toHaveBeenCalledWith(1);
    // Fit-to-width: base viewport is 600 wide at scale 1, the column is 900,
    // so the render viewport is requested at scale 900/600 (dpr 1 in tests).
    expect(pdfjsMock.page.getViewport).toHaveBeenLastCalledWith({ scale: 900 / 600 });
    const renderArgs = (pdfjsMock.page.render.mock.calls[0] as unknown[])[0] as {
      canvas: HTMLCanvasElement;
      viewport: { width: number };
    };
    expect(renderArgs.canvas).toBeInstanceOf(HTMLCanvasElement);
    expect(renderArgs.canvas.width).toBe(900);
  });

  it('pages forward and back, and pins the pager at both ends', async () => {
    stubPdfFetch();
    const user = userEvent.setup();
    renderWithWorkspace('ws-1');

    await screen.findByText('Page 1 of 3');
    const prev = screen.getByRole('button', { name: 'Prev' });
    const next = screen.getByRole('button', { name: 'Next' });
    // First page: nowhere back to go.
    expect(prev).toBeDisabled();

    await user.click(next);
    await screen.findByText('Page 2 of 3');
    await waitFor(() => expect(pdfjsMock.doc.getPage).toHaveBeenCalledWith(2));
    expect(prev).toBeEnabled();

    await user.click(next);
    await screen.findByText('Page 3 of 3');
    // Last page: the pager stops, it does not wrap.
    expect(next).toBeDisabled();

    await user.click(prev);
    await screen.findByText('Page 2 of 3');
  });

  it('offers Download in the toolbar', async () => {
    stubPdfFetch();
    renderWithWorkspace('ws-1');
    await screen.findByText('Page 1 of 3');
    expect(screen.getByRole('button', { name: /Download/ })).toBeInTheDocument();
  });

  it('shows the loading state until the document resolves', async () => {
    let resolveFetch!: (res: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve;
          }),
      ),
    );

    renderWithWorkspace('ws-1');
    expect(screen.getByText('Loading PDF…')).toBeInTheDocument();

    resolveFetch(new Response(new Blob([new Uint8Array([0x25])]), { status: 200 }));
    await screen.findByText('Page 1 of 3');
  });

  it('says the file could not be parsed as a PDF when pdf.js rejects it, and still offers Download', async () => {
    stubPdfFetch();
    // A renamed .txt, a truncated upload — the fetch succeeded, the parse did not.
    pdfjsMock.getDocument.mockImplementation(() =>
      pdfjsMock.makeTask(Promise.reject(new Error('Invalid PDF structure'))),
    );
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    renderWithWorkspace('ws-1');
    await screen.findByText('This file could not be parsed as a PDF.');
    // The bytes may still be fine for a desktop viewer.
    expect(screen.getByRole('button', { name: /Download/ })).toBeInTheDocument();
  });

  it('destroys the rejected loading task on parse failure — the error view must not keep it alive — without double-destroying on unmount', async () => {
    stubPdfFetch();
    let task!: ReturnType<typeof pdfjsMock.makeTask>;
    pdfjsMock.getDocument.mockImplementation(() => {
      task = pdfjsMock.makeTask(Promise.reject(new Error('Invalid PDF structure')));
      return task;
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { unmount } = renderWithWorkspace('ws-1');
    await screen.findByText('This file could not be parsed as a PDF.');
    // Torn down on the rejection path, while the error view is mounted…
    expect(task.destroy).toHaveBeenCalledTimes(1);

    // …and the effect cleanup does not destroy it a second time.
    unmount();
    expect(task.destroy).toHaveBeenCalledTimes(1);
  });

  it('renders an error message when the fetch returns a non-OK response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not found', { status: 404 })),
    );
    renderWithWorkspace('ws-1');
    await screen.findByText(/Failed to load PDF \(HTTP 404\)/);
  });

  it('renders an error message when fetch throws (network failure)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );
    renderWithWorkspace('ws-1');
    await screen.findByText('network down');
  });

  it('destroys the worker-side document on unmount', async () => {
    stubPdfFetch();
    const { unmount } = renderWithWorkspace('ws-1');
    await screen.findByText('Page 1 of 3');

    unmount();
    expect(pdfjsMock.doc.destroy).toHaveBeenCalled();
  });

  it('destroys the LOADING TASK on unmount even while the document is still resolving — a doc that resolves after cancellation is torn down, not leaked', async () => {
    stubPdfFetch();
    let resolveDoc!: (d: unknown) => void;
    let task!: ReturnType<typeof pdfjsMock.makeTask>;
    pdfjsMock.getDocument.mockImplementation(() => {
      task = pdfjsMock.makeTask(
        new Promise((resolve) => {
          resolveDoc = resolve;
        }),
      );
      return task;
    });

    const { unmount } = renderWithWorkspace('ws-1');
    // Let the fetch finish and getDocument fire.
    await waitFor(() => expect(pdfjsMock.getDocument).toHaveBeenCalled());
    unmount();
    // The task is destroyed although its promise never resolved…
    expect(task.destroy).toHaveBeenCalled();
    // …and a late resolution changes nothing (destroy already covered it).
    resolveDoc(pdfjsMock.doc);
    await new Promise((r) => setTimeout(r, 0));
    expect(pdfjsMock.doc.destroy).toHaveBeenCalled();
  });

  it('releases the PRIOR page (page.cleanup) only after the next page has rendered — never mid-render', async () => {
    stubPdfFetch();
    const makePage = () => ({
      getViewport: vi.fn(({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale })),
      render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
      cleanup: vi.fn(),
    });
    const pages: Record<number, ReturnType<typeof makePage>> = { 1: makePage(), 2: makePage() };
    pdfjsMock.doc.getPage.mockImplementation(async (n: number) => pages[n] ?? makePage());

    const user = userEvent.setup();
    renderWithWorkspace('ws-1');
    await screen.findByText('Page 1 of 3');
    await waitFor(() => expect(pages[1].render).toHaveBeenCalled());
    // Page 1's resources stay live while page 1 is the one on screen.
    expect(pages[1].cleanup).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText('Page 2 of 3');
    await waitFor(() => expect(pages[2].render).toHaveBeenCalled());
    // After page 2's render settles the prior page is released…
    await waitFor(() => expect(pages[1].cleanup).toHaveBeenCalledTimes(1));
    // …and the CURRENT page is not.
    expect(pages[2].cleanup).not.toHaveBeenCalled();
  });

  it('does not fetch when workspaceId is null', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    renderWithWorkspace(null);

    // Give effects a chance to run.
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(screen.getByText('Loading PDF…')).toBeInTheDocument();
  });
});
