import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { getFileRenderer } from '..';
import { GitContext, type GitContextValue } from '../../../../git';
import { WorkspaceContext, type WorkspaceContextValue } from '../../../state/workspace.context';
import { PageLinkHomeContext } from '../htmlToolBridge';

/**
 * A link written in an HTML page, as the app follows it: the frame's nav
 * bridge posts `bevel.navigate`, and the page's file opens in a NEW TAB at its
 * plain address while this tab — its address, its full-screen view — stays.
 */

const HtmlRenderer = getFileRenderer('Dashboards/Roadmap.html');
const PATH = 'knowledge-base/Dashboards/Roadmap.html';
const AT = '/workspace/main/knowledge-base/Dashboards/Roadmap.html';

const workspace = { workspaceId: 'main', kbDirName: 'knowledge-base' } as unknown as WorkspaceContextValue;
const git = { status: { branch: 'main' } } as unknown as GitContextValue;

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname + location.search + location.hash}</output>;
}

function onFilePage(at: string) {
  return render(
    <MemoryRouter initialEntries={[at]}>
      <WorkspaceContext.Provider value={workspace}>
        <GitContext.Provider value={git}>
          <HtmlRenderer content="<h1>Roadmap</h1>" filePath={PATH} onSave={async () => undefined} readOnly />
          <LocationProbe />
        </GitContext.Provider>
      </WorkspaceContext.Provider>
    </MemoryRouter>,
  );
}

function frameOf(container: HTMLElement) {
  return waitFor(() => {
    const el = container.querySelector('iframe');
    if (!el) throw new Error('no frame yet');
    return el;
  });
}

/** Post a link click from the frame, as its nav bridge does; `newTab` for a modified or middle click. */
async function clickInFrame(container: HTMLElement, href: string, newTab = false) {
  const iframe = await frameOf(container);
  window.dispatchEvent(
    new MessageEvent('message', {
      data: newTab ? { type: 'bevel.navigate', href, newTab } : { type: 'bevel.navigate', href },
      source: iframe.contentWindow,
    }),
  );
}

function stubWindowOpen() {
  return vi.spyOn(window, 'open').mockImplementation(() => ({ opener: window }) as unknown as Window);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('a link inside an HTML page', () => {
  it('opens the linked file in a new tab and leaves this tab where it is', async () => {
    const open = stubWindowOpen();
    const { container } = onFilePage(AT);
    await clickInFrame(container, '../Knowledge/Plan.md');
    expect(open).toHaveBeenCalledWith('/workspace/main/knowledge-base/Knowledge/Plan.md', '_blank');
    expect(screen.getByTestId('location').textContent).toBe(AT);
  });

  it('in full screen, opens the plain address and the page stays full screen', async () => {
    const open = stubWindowOpen();
    const { container } = onFilePage(`${AT}?fullscreen=1`);
    await clickInFrame(container, 'Board.html#totals');
    expect(open).toHaveBeenCalledWith('/workspace/main/knowledge-base/Dashboards/Board.html#totals', '_blank');
    expect(screen.getByTestId('location').textContent).toBe(`${AT}?fullscreen=1`);
  });

  it('scrolls a link to a section of the page itself inside the frame, and this tab stays put', async () => {
    const open = stubWindowOpen();
    const { container } = onFilePage(`${AT}?fullscreen=1`);
    const frame = await frameOf(container);
    const post = vi.spyOn(frame.contentWindow!, 'postMessage');
    await clickInFrame(container, 'Roadmap.html#q3');
    await clickInFrame(container, '/workspace/main/knowledge-base/Dashboards/Roadmap.html#q4');
    expect(open).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledWith({ type: 'bevel.jump', hash: '#q3' }, '*');
    expect(post).toHaveBeenCalledWith({ type: 'bevel.jump', hash: '#q4' }, '*');
    expect(screen.getByTestId('location').textContent).toBe(`${AT}?fullscreen=1`);
  });

  // Where a section link's new tab lands: `Board.html#totals`. The fragment
  // is on the app's address, which the frame never sees, so the page is
  // handed it once it has loaded, as a click on a section link inside it is.
  it('scrolls the page to the section its address names once the frame has loaded', async () => {
    const { container } = onFilePage(`${AT}#q3`);
    const frame = await frameOf(container);
    const post = vi.spyOn(frame.contentWindow!, 'postMessage');
    fireEvent.load(frame);
    expect(post).toHaveBeenCalledWith({ type: 'bevel.jump', hash: '#q3' }, '*');
    expect(screen.getByTestId('location').textContent).toBe(`${AT}#q3`);
  });

  it('in full screen, scrolls the page to the section its address names too', async () => {
    const { container } = onFilePage(`${AT}?fullscreen=1#totals`);
    const frame = await frameOf(container);
    const post = vi.spyOn(frame.contentWindow!, 'postMessage');
    fireEvent.load(frame);
    expect(post).toHaveBeenCalledWith({ type: 'bevel.jump', hash: '#totals' }, '*');
  });

  it('hands the frame no jump when its address names no section', async () => {
    const { container } = onFilePage(AT);
    const frame = await frameOf(container);
    const post = vi.spyOn(frame.contentWindow!, 'postMessage');
    fireEvent.load(frame);
    expect(post).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'bevel.jump' }), '*');
  });

  it('resolves against the page home its host names (a skill page), on that branch', async () => {
    const open = stubWindowOpen();
    const { container } = render(
      <MemoryRouter initialEntries={['/library/skills/report']}>
        <WorkspaceContext.Provider value={workspace}>
          <GitContext.Provider value={{ status: { branch: 'draft' } } as unknown as GitContextValue}>
            <PageLinkHomeContext.Provider value={{ path: 'knowledge-base/Skills/report/view.html', branch: 'main' }}>
              <HtmlRenderer content="<h1>View</h1>" filePath="view.html" onSave={async () => undefined} readOnly />
            </PageLinkHomeContext.Provider>
            <LocationProbe />
          </GitContext.Provider>
        </WorkspaceContext.Provider>
      </MemoryRouter>,
    );
    const frame = await frameOf(container);
    const post = vi.spyOn(frame.contentWindow!, 'postMessage');
    await clickInFrame(container, 'template.md');
    expect(open).toHaveBeenCalledWith('/workspace/main/knowledge-base/Skills/report/template.md', '_blank');
    await clickInFrame(container, 'view.html#steps');
    expect(post).toHaveBeenCalledWith({ type: 'bevel.jump', hash: '#steps' }, '*');
    expect(open).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('location').textContent).toBe('/library/skills/report');
  });

  // A modified or middle click in the page, relayed by the bridge: the
  // browser would open the link in a new tab, so the app does, a section of
  // this page included (where it would otherwise scroll in place), at the
  // plain address; this tab and its full-screen view stay.
  it('opens a modified click in a new tab at the plain address, a section of this page too', async () => {
    const open = stubWindowOpen();
    const { container } = onFilePage(`${AT}?fullscreen=1`);
    const frame = await frameOf(container);
    const post = vi.spyOn(frame.contentWindow!, 'postMessage');
    await clickInFrame(container, 'Board.html', true);
    await clickInFrame(container, '#q3', true);
    await clickInFrame(container, 'Roadmap.html#q4', true);
    expect(open.mock.calls).toEqual([
      ['/workspace/main/knowledge-base/Dashboards/Board.html', '_blank'],
      [`${AT}#q3`, '_blank'],
      [`${AT}#q4`, '_blank'],
    ]);
    expect(post).not.toHaveBeenCalled();
    expect(screen.getByTestId('location').textContent).toBe(`${AT}?fullscreen=1`);
  });

  it('opens a modified click on an external link in a new tab, as a plain one', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const { container } = onFilePage(AT);
    await clickInFrame(container, 'https://example.com/docs', true);
    expect(open).toHaveBeenCalledWith('https://example.com/docs', '_blank', 'noopener,noreferrer');
  });

  it('opens an external link as before, with no referrer', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const { container } = onFilePage(AT);
    await clickInFrame(container, 'https://example.com/docs');
    expect(open).toHaveBeenCalledWith('https://example.com/docs', '_blank', 'noopener,noreferrer');
    expect(screen.getByTestId('location').textContent).toBe(AT);
  });
});
