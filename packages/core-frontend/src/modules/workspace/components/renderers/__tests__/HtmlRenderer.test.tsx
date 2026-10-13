import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { HtmlRenderer } from '../HtmlRenderer';
import { RendererSurfaceContext, type RendererSurface } from '../rendererSurface';

/** A surface outside the app, with only what the HTML view reads of it. */
function surface(extra: Partial<RendererSurface>): RendererSurface {
  return {
    kbDirName: 'knowledge-base',
    openLink: () => undefined,
    openWorkspacePath: () => undefined,
    openNodeId: () => undefined,
    canonicalUrlFor: () => null,
    rawUrl: (path) => `/raw/${path}`,
    rawFetch: async () => new Response(''),
    offersDownload: false,
    ...extra,
  };
}

function page(s: RendererSurface, content: string) {
  return (
    <MemoryRouter>
      <RendererSurfaceContext.Provider value={s}>
        <HtmlRenderer content={content} filePath="Pages/Board.html" onSave={async () => undefined} readOnly />
      </RendererSurfaceContext.Provider>
    </MemoryRouter>
  );
}

function mount(s: RendererSurface, content = '<h1>Board</h1>') {
  return render(page(s, content));
}

/** The frame once the preview is built. */
async function frameOf(container: HTMLElement): Promise<HTMLIFrameElement> {
  return waitFor(() => {
    const el = container.querySelector('iframe');
    if (!el) throw new Error('no frame yet');
    return el;
  });
}

/** What the page inside the frame posts, as the frame's window. */
function frameSays(iframe: HTMLIFrameElement, data: unknown) {
  window.dispatchEvent(new MessageEvent('message', { data, source: iframe.contentWindow }));
}

describe('HtmlRenderer on a surface', () => {
  afterEach(cleanup);

  it('sizes its frame to the height the page reports where the host grows with the content', async () => {
    const { container } = mount(surface({ sizesToContent: true }));
    const iframe = await frameOf(container);
    expect(iframe.className).toContain('shrink-0');
    expect(iframe.className).not.toContain('flex-1');
    expect(iframe.style.height).toBe('');

    frameSays(iframe, { type: 'bevel.height', height: 640.2 });
    await waitFor(() => expect(iframe.style.height).toBe('641px'));
    // The content box, so the viewport is the reported height and the
    // border is not taken out of the page; and never below a short pane.
    expect(iframe.style.boxSizing).toBe('content-box');
    expect(iframe.className).toContain('min-h-60');

    // Something that is not a height, or not from the frame, changes nothing.
    frameSays(iframe, { type: 'bevel.height', height: -5 });
    frameSays(iframe, { type: 'bevel.navigate', href: 'Other.html' });
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'bevel.height', height: 99 }, source: window }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(iframe.style.height).toBe('641px');

    frameSays(iframe, { type: 'bevel.height', height: 1200 });
    await waitFor(() => expect(iframe.style.height).toBe('1200px'));
  });

  it('starts a rebuilt page from the frame\'s own height, never the previous page\'s', async () => {
    const s = surface({ sizesToContent: true });
    const { container, rerender } = mount(s, '<h1>Board</h1><p>a long report</p>');
    const tall = await frameOf(container);
    frameSays(tall, { type: 'bevel.height', height: 900 });
    await waitFor(() => expect(tall.style.height).toBe('900px'));

    // A shorter page arrives: its frame carries no height until it reports
    // its own, so the host is never told the old page's height for the new.
    rerender(page(s, '<h1>Board</h1>'));
    const short = await waitFor(() => {
      const el = container.querySelector('iframe')!;
      if (el.style.height !== '') throw new Error('still the old height');
      return el;
    });
    frameSays(short, { type: 'bevel.height', height: 120 });
    await waitFor(() => expect(short.style.height).toBe('120px'));
  });

  it('starts a refreshed page from the frame\'s own height too, though its text is the same', async () => {
    const { container } = mount(surface({ sizesToContent: true }));
    const first = await frameOf(container);
    frameSays(first, { type: 'bevel.height', height: 900 });
    await waitFor(() => expect(first.style.height).toBe('900px'));

    // Refresh remounts the same document as a new frame: no height until
    // that frame has reported its own.
    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));
    const refreshed = await waitFor(() => {
      const el = container.querySelector('iframe')!;
      if (el === first || el.style.height !== '') throw new Error('still the old frame, or its height');
      return el;
    });
    frameSays(refreshed, { type: 'bevel.height', height: 120 });
    await waitFor(() => expect(refreshed.style.height).toBe('120px'));
  });

  it('keeps filling its pane, and ignores the reported height, where the host gives it one', async () => {
    const { container } = mount(surface({}));
    const iframe = await frameOf(container);
    expect(iframe.className).toContain('flex-1');
    frameSays(iframe, { type: 'bevel.height', height: 640 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(iframe.style.height).toBe('');
  });
});
