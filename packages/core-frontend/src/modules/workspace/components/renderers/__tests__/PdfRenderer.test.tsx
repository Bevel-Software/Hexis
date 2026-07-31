import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import {
  WorkspaceContext,
  type WorkspaceContextValue,
} from '../../../state/workspace.context';
import { PdfRenderer } from '../PdfRenderer';

// Minimal WorkspaceContext: PdfRenderer only reads `workspaceId`. Casting the
// stub via `unknown` keeps the test focused — the full context shape has 40+
// fields, none of which PdfRenderer touches.
function workspaceCtx(workspaceId: string | null): WorkspaceContextValue {
  return { workspaceId } as unknown as WorkspaceContextValue;
}

const baseProps = {
  filePath: 'Inbox/brief.pdf',
  content: '',
  onSave: async () => {},
};

function renderWithWorkspace(workspaceId: string | null = 'ws-1') {
  return render(
    <WorkspaceContext.Provider value={workspaceCtx(workspaceId)}>
      <PdfRenderer {...baseProps} />
    </WorkspaceContext.Provider>,
  );
}

let createObjectURLSpy: ReturnType<typeof vi.fn>;
let revokeObjectURLSpy: ReturnType<typeof vi.fn>;
const objectUrls: string[] = [];

// jsdom does not implement URL.createObjectURL / revokeObjectURL — install
// them as own-properties on the global URL class. We must NOT replace the
// URL global itself (vi.stubGlobal('URL', …)) because Response/Blob/fetch
// internals construct `new URL(…)` and would break.
beforeEach(() => {
  objectUrls.length = 0;
  createObjectURLSpy = vi.fn(() => {
    const url = `blob:fake/${objectUrls.length}`;
    objectUrls.push(url);
    return url;
  });
  revokeObjectURLSpy = vi.fn();
  (URL as unknown as { createObjectURL: typeof createObjectURLSpy }).createObjectURL =
    createObjectURLSpy;
  (URL as unknown as { revokeObjectURL: typeof revokeObjectURLSpy }).revokeObjectURL =
    revokeObjectURLSpy;
});

afterEach(() => {
  delete (URL as unknown as { createObjectURL?: unknown }).createObjectURL;
  delete (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('PdfRenderer', () => {
  it('fetches the PDF and renders an iframe with the issued blob URL', async () => {
    const pdfBytes = new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46])], {
      type: 'application/pdf',
    });
    const fetchSpy = vi.fn<typeof fetch>(async () => new Response(pdfBytes, { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    renderWithWorkspace('ws-1');

    const iframe = await waitFor(() => screen.getByTitle('Inbox/brief.pdf'));
    expect(iframe.tagName).toBe('IFRAME');
    expect((iframe as HTMLIFrameElement).src).toBe(objectUrls[0]);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const calledUrl = String(fetchSpy.mock.calls[0]![0]);
    expect(calledUrl).toContain('/api/workspace/ws-1/file/raw');
    expect(calledUrl).toContain('path=Inbox%2Fbrief.pdf');
  });

  it('shows the loading state until the blob resolves', async () => {
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
    expect(screen.getByText('Loading PDF...')).toBeInTheDocument();

    resolveFetch(
      new Response(new Blob([new Uint8Array([0x25])], { type: 'application/pdf' }), {
        status: 200,
      }),
    );
    await waitFor(() => screen.getByTitle('Inbox/brief.pdf'));
  });

  it('renders an error message when the fetch returns a non-OK response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not found', { status: 404 })),
    );

    renderWithWorkspace('ws-1');
    await waitFor(() =>
      expect(screen.getByText(/Failed to load PDF \(HTTP 404\)/)).toBeInTheDocument(),
    );
  });

  it('renders an error message when fetch throws (network failure)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );

    renderWithWorkspace('ws-1');
    await waitFor(() => expect(screen.getByText('network down')).toBeInTheDocument());
  });

  it('revokes the object URL on unmount', async () => {
    const pdfBytes = new Blob([new Uint8Array([0x25])], {
      type: 'application/pdf',
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(pdfBytes, { status: 200 })));

    const { unmount } = renderWithWorkspace('ws-1');
    await waitFor(() => screen.getByTitle('Inbox/brief.pdf'));

    expect(createObjectURLSpy).toHaveBeenCalledTimes(1);
    unmount();
    expect(revokeObjectURLSpy).toHaveBeenCalledWith(objectUrls[0]);
  });

  it('does not fetch when workspaceId is null', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    renderWithWorkspace(null);

    // Give effects a chance to run.
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(screen.getByText('Loading PDF...')).toBeInTheDocument();
  });

  it('URL-encodes filePath segments so paths with spaces and slashes work', async () => {
    const pdfBytes = new Blob([new Uint8Array([0x25])], { type: 'application/pdf' });
    const fetchSpy = vi.fn<typeof fetch>(async () => new Response(pdfBytes, { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    render(
      <WorkspaceContext.Provider value={workspaceCtx('ws-1')}>
        <PdfRenderer {...baseProps} filePath="My Folder/Q3 report.pdf" />
      </WorkspaceContext.Provider>,
    );

    await waitFor(() => screen.getByTitle('My Folder/Q3 report.pdf'));
    const calledUrl = String(fetchSpy.mock.calls[0]![0]);
    expect(calledUrl).toContain('path=My%20Folder%2FQ3%20report.pdf');
  });
});
