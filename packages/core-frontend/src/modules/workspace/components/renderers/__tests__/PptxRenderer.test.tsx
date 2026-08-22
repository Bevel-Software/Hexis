import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import JSZip from 'jszip';
import {
  WorkspaceContext,
  type WorkspaceContextValue,
} from '../../../state/workspace.context';

const apiMock = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('../../../../../lib/api', () => ({ authFetch: apiMock.authFetch }));

import { PptxRenderer } from '../PptxRenderer';

/**
 * The viewer over a real (minimal) deck: parsing is `pptxOutline.test.ts`'s
 * job; this proves the outline actually reaches the screen in the promised
 * shape — slide sections in order, notes under their slide, the up-front
 * "this is an outline" note, and Download on both the happy and the failed
 * path. Everything from the document renders as React text nodes, so there
 * is no HTML-injection surface to pin here (unlike `DocxRenderer`).
 */

async function deckBytes(): Promise<ArrayBuffer> {
  const zip = new JSZip();
  zip.file(
    'ppt/slides/slide1.xml',
    '<p:sld><a:p><a:r><a:t>Road</a:t></a:r><a:r><a:t>map</a:t></a:r></a:p></p:sld>',
  );
  zip.file('ppt/slides/slide2.xml', '<p:sld><a:p><a:t>The ask</a:t></a:p></p:sld>');
  zip.file(
    'ppt/notesSlides/notesSlide2.xml',
    '<p:notes><a:p><a:t>pause for questions</a:t></a:p></p:notes>',
  );
  return zip.generateAsync({ type: 'arraybuffer' });
}

function renderPptx() {
  return render(
    <WorkspaceContext.Provider
      value={{ workspaceId: 'ws-1' } as unknown as WorkspaceContextValue}
    >
      <PptxRenderer filePath="Inbox/all-hands.pptx" content="" onSave={async () => {}} />
    </WorkspaceContext.Provider>,
  );
}

beforeEach(() => {
  apiMock.authFetch.mockReset();
});

describe('PptxRenderer', () => {
  it('renders the outline: slide sections in order, runs joined, notes attached', async () => {
    const bytes = await deckBytes();
    apiMock.authFetch.mockResolvedValue({ ok: true, arrayBuffer: async () => bytes });

    renderPptx();

    const slide1 = await screen.findByRole('heading', { name: 'Slide 1' });
    const slide2 = screen.getByRole('heading', { name: 'Slide 2' });
    // Package order on screen.
    expect(
      slide1.compareDocumentPosition(slide2) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // Runs joined with no separator.
    expect(screen.getByText('Roadmap')).toBeInTheDocument();
    // Notes under THEIR slide: scoped inside Slide 2's section, so a
    // wrong-slide attachment fails instead of passing on a page-wide match.
    const slide2Section = slide2.closest('section')!;
    expect(within(slide2Section).getByText('Notes')).toBeInTheDocument();
    expect(within(slide2Section).getByText('pause for questions')).toBeInTheDocument();
    expect(within(slide1.closest('section')!).queryByText('Notes')).not.toBeInTheDocument();
    // The honest header: what this view is, and the way to the real deck.
    expect(screen.getByText(/Text outline of the presentation/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Download/ })).toBeInTheDocument();
  });

  it('says the file could not be parsed as a .pptx and still offers Download', async () => {
    const bytes = new TextEncoder().encode('renamed zip that is not one').buffer;
    apiMock.authFetch.mockResolvedValue({ ok: true, arrayBuffer: async () => bytes });

    renderPptx();

    expect(
      await screen.findByText(/This file could not be parsed as a \.pptx/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Download/ })).toBeInTheDocument();
  });

  it('rejects an over-cap declared Content-Length AND cancels the body — the transfer must stop', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    apiMock.authFetch.mockResolvedValue({
      ok: true,
      headers: { get: (name: string) => (name === 'content-length' ? String(201 * 1024 * 1024) : null) },
      body: { cancel },
    });

    renderPptx();

    expect(
      await screen.findByText(/This presentation is too large to preview/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Download/ })).toBeInTheDocument();
    // The guard is only real if it ends the transfer, not just the render.
    expect(cancel).toHaveBeenCalled();
  });

  it('reports a transport failure as a load error', async () => {
    apiMock.authFetch.mockResolvedValue({ ok: false, status: 403 });

    renderPptx();

    expect(
      await screen.findByText(/Failed to load presentation \(HTTP 403\)/),
    ).toBeInTheDocument();
  });
});
