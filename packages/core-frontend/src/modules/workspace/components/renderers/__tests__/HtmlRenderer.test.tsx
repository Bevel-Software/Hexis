import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
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

function mount(s: RendererSurface) {
  return render(
    <MemoryRouter>
      <RendererSurfaceContext.Provider value={s}>
        <HtmlRenderer content="<h1>Board</h1>" filePath="Pages/Board.html" onSave={async () => undefined} readOnly />
      </RendererSurfaceContext.Provider>
    </MemoryRouter>,
  );
}

/** What the page inside the frame posts, as the frame's window. */
function frameSays(iframe: HTMLIFrameElement, data: unknown) {
  window.dispatchEvent(new MessageEvent('message', { data, source: iframe.contentWindow }));
}

describe('HtmlRenderer on a surface', () => {
  afterEach(cleanup);

  it('sizes its frame to the height the page reports where the host grows with the content', async () => {
    const { container } = mount(surface({ sizesToContent: true }));
    const iframe = await waitFor(() => {
      const el = container.querySelector('iframe');
      if (!el) throw new Error('no frame yet');
      return el;
    });
    expect(iframe.className).toContain('shrink-0');
    expect(iframe.className).not.toContain('flex-1');
    expect(iframe.style.height).toBe('');

    frameSays(iframe, { type: 'bevel.height', height: 640.2 });
    await waitFor(() => expect(iframe.style.height).toBe('641px'));

    // Something that is not a height, or not from the frame, changes nothing.
    frameSays(iframe, { type: 'bevel.height', height: -5 });
    frameSays(iframe, { type: 'bevel.navigate', href: 'Other.html' });
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'bevel.height', height: 99 }, source: window }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(iframe.style.height).toBe('641px');

    frameSays(iframe, { type: 'bevel.height', height: 1200 });
    await waitFor(() => expect(iframe.style.height).toBe('1200px'));
  });

  it('keeps filling its pane, and ignores the reported height, where the host gives it one', async () => {
    const { container } = mount(surface({}));
    const iframe = await waitFor(() => {
      const el = container.querySelector('iframe');
      if (!el) throw new Error('no frame yet');
      return el;
    });
    expect(iframe.className).toContain('flex-1');
    frameSays(iframe, { type: 'bevel.height', height: 640 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(iframe.style.height).toBe('');
  });
});
