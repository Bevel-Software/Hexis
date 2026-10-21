import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
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

/** Post a link click from the frame, as its nav bridge does. */
async function clickInFrame(container: HTMLElement, href: string) {
  const iframe = await frameOf(container);
  window.dispatchEvent(
    new MessageEvent('message', { data: { type: 'bevel.navigate', href }, source: iframe.contentWindow }),
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

  it('opens an external link as before, with no referrer', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const { container } = onFilePage(AT);
    await clickInFrame(container, 'https://example.com/docs');
    expect(open).toHaveBeenCalledWith('https://example.com/docs', '_blank', 'noopener,noreferrer');
    expect(screen.getByTestId('location').textContent).toBe(AT);
  });
});
