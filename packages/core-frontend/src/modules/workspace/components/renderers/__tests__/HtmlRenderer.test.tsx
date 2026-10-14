import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RendererSurfaceContext, getFileRenderer, type RendererSurface } from '..';

/** The renderer the module hands out for an `.html` page — the way the app and the embed get it. */
const HtmlRenderer = getFileRenderer('Pages/Board.html');

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

const STORED = 'bevel.htmlFrame.height';

/** The handle under the frame. */
const handle = () => screen.getByRole('separator', { name: 'Resize the page' });

/** A drag of the handle by `dy`, as the pointer reports it. */
function drag(dy: number) {
  const el = handle();
  fireEvent.pointerDown(el, { button: 0, clientY: 100, pointerId: 1 });
  fireEvent.pointerMove(el, { clientY: 100 + dy, pointerId: 1 });
  fireEvent.pointerUp(el, { clientY: 100 + dy, pointerId: 1 });
}

describe('HtmlRenderer on a surface', () => {
  afterEach(() => {
    cleanup();
    window.localStorage.removeItem(STORED);
  });

  it('gives its frame the standard height, as a content box, with a handle to resize it, where the host grows with the content', async () => {
    const { container } = mount(surface({ sizesToContent: true }));
    const iframe = await frameOf(container);
    expect(iframe.className).toContain('shrink-0');
    expect(iframe.className).not.toContain('flex-1');
    // The content box, so the page's viewport is exactly the height and the
    // border is not taken out of it.
    expect(iframe.style.height).toBe('480px');
    expect(iframe.style.boxSizing).toBe('content-box');
    expect(handle().getAttribute('aria-valuenow')).toBe('480');
    expect(handle().getAttribute('aria-valuemin')).toBe('160');
    expect(handle().getAttribute('aria-valuemax')).toBe('2400');
    // A finger on the handle is a resize, never a scroll of the page.
    expect(handle().style.touchAction).toBe('none');
  });

  it('the reader drags the handle to make the frame taller or shorter, and the choice is kept in this browser', async () => {
    const { container, unmount } = mount(surface({ sizesToContent: true }));
    const iframe = await frameOf(container);
    const el = handle();
    fireEvent.pointerDown(el, { button: 0, clientY: 100, pointerId: 1 });
    // While the drag lasts the frame takes no pointer, so the drag can cross it.
    fireEvent.pointerMove(el, { clientY: 160, pointerId: 1 });
    await waitFor(() => expect(iframe.style.height).toBe('540px'));
    expect(el.getAttribute('data-dragging')).toBe('true');
    expect(iframe.style.pointerEvents).toBe('none');
    fireEvent.pointerMove(el, { clientY: 220, pointerId: 1 });
    fireEvent.pointerUp(el, { clientY: 220, pointerId: 1 });
    await waitFor(() => expect(iframe.style.height).toBe('600px'));
    expect(el.hasAttribute('data-dragging')).toBe(false);
    expect(iframe.style.pointerEvents).toBe('');
    expect(window.localStorage.getItem(STORED)).toBe('600');

    // Shorter, and never below the least: a page is still a page at 160.
    drag(-1000);
    await waitFor(() => expect(iframe.style.height).toBe('160px'));
    expect(window.localStorage.getItem(STORED)).toBe('160');
    // Taller, and never past the most: the range the handle announces.
    drag(10_000);
    await waitFor(() => expect(iframe.style.height).toBe('2400px'));
    expect(handle().getAttribute('aria-valuenow')).toBe('2400');
    drag(-1000);
    await waitFor(() => expect(iframe.style.height).toBe('1400px'));

    // The next frame in this browser starts where this one was left.
    unmount();
    const again = mount(surface({ sizesToContent: true }));
    expect((await frameOf(again.container)).style.height).toBe('1400px');

    // A stored height outside the range is not believed.
    again.unmount();
    window.localStorage.setItem(STORED, '99999');
    const standard = mount(surface({ sizesToContent: true }));
    expect((await frameOf(standard.container)).style.height).toBe('480px');
  });

  it('the arrow keys nudge the frame by a step, and a drag that is not the main button is ignored', async () => {
    const { container } = mount(surface({ sizesToContent: true }));
    const iframe = await frameOf(container);
    fireEvent.keyDown(handle(), { key: 'ArrowDown' });
    await waitFor(() => expect(iframe.style.height).toBe('504px'));
    fireEvent.keyDown(handle(), { key: 'ArrowUp' });
    fireEvent.keyDown(handle(), { key: 'ArrowUp' });
    await waitFor(() => expect(iframe.style.height).toBe('456px'));
    fireEvent.keyDown(handle(), { key: 'Enter' });
    expect(iframe.style.height).toBe('456px');

    const el = handle();
    fireEvent.pointerDown(el, { button: 2, clientY: 100, pointerId: 2 });
    fireEvent.pointerMove(el, { clientY: 300, pointerId: 2 });
    fireEvent.pointerUp(el, { clientY: 300, pointerId: 2 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(iframe.style.height).toBe('456px');
  });

  it('keeps filling its pane, with no handle, where the host gives it one', async () => {
    const { container } = mount(surface({}));
    const iframe = await frameOf(container);
    expect(iframe.className).toContain('flex-1');
    expect(iframe.style.height).toBe('');
    expect(screen.queryByRole('separator')).toBeNull();
  });
});
