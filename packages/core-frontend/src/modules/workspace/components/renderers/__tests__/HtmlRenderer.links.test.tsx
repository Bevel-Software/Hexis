import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { getFileRenderer } from '..';
import { GitContext, type GitContextValue } from '../../../../git';
import { WorkspaceContext, type WorkspaceContextValue } from '../../../state/workspace.context';

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

/** Post a link click from the frame, as its nav bridge does. */
async function clickInFrame(container: HTMLElement, href: string) {
  const iframe = await waitFor(() => {
    const el = container.querySelector('iframe');
    if (!el) throw new Error('no frame yet');
    return el;
  });
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

  it('keeps a link to a section of the page itself in this tab, query kept', async () => {
    const open = stubWindowOpen();
    const { container } = onFilePage(`${AT}?fullscreen=1`);
    await clickInFrame(container, 'Roadmap.html#q3');
    expect(open).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe(`${AT}?fullscreen=1#q3`));
  });

  it('opens an external link as before, with no referrer', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const { container } = onFilePage(AT);
    await clickInFrame(container, 'https://example.com/docs');
    expect(open).toHaveBeenCalledWith('https://example.com/docs', '_blank', 'noopener,noreferrer');
    expect(screen.getByTestId('location').textContent).toBe(AT);
  });
});
