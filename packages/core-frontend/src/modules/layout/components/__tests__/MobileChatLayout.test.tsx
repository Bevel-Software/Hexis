import { beforeEach, describe, it, expect } from 'vitest';
import { render, screen, waitForElementToBeRemoved } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { MobileChatLayout } from '../MobileChatLayout';
import { useLayout } from '../../state/layout.context';
import {
  SIDEBAR_DOM_ID,
  SIDEBAR_DRAWER_MAX_WIDTH,
  SIDEBAR_DRAWER_WIDTH,
} from '../SidebarFrame';
import { setSidebarCollapsed } from '../../state/sidebar';

function setViewportWidth(width: number): void {
  const testWindow = window as typeof window & {
    happyDOM: { setInnerWidth(value: number): void };
  };
  testWindow.happyDOM.setInnerWidth(width);
}

function HeaderToggle() {
  const { toggleExplorer, canToggleChat } = useLayout();
  return (
    <div>
      <button type="button" onClick={toggleExplorer}>
        open-explorer
      </button>
      <span data-testid="can-toggle-chat">{String(canToggleChat)}</span>
    </div>
  );
}

function renderLayout(initialPath: string) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <MobileChatLayout
        header={<HeaderToggle />}
        explorer={<div>FILE_EXPLORER</div>}
        viewer={<div>FILE_VIEWER</div>}
        chat={<div>CHAT_PANEL</div>}
      />
    </MemoryRouter>,
  );
}

describe('MobileChatLayout', () => {
  beforeEach(() => {
    setViewportWidth(375);
    setSidebarCollapsed(false);
  });

  it('always renders the chat slot and hides the explorer until opened', () => {
    renderLayout('/');
    expect(screen.getByText('CHAT_PANEL')).toBeInTheDocument();
    expect(document.getElementById(SIDEBAR_DOM_ID)).toHaveAttribute('inert');
  });

  it('exposes canToggleChat=false because chat is pinned full-screen', () => {
    renderLayout('/');
    expect(screen.getByTestId('can-toggle-chat').textContent).toBe('false');
  });

  it('mounts the explorer drawer when the hamburger toggles it open', async () => {
    const user = userEvent.setup();
    renderLayout('/');
    await user.click(screen.getByRole('button', { name: 'open-explorer' }));
    const drawer = screen.getByRole('dialog', { name: 'File explorer' });
    expect(drawer.style.width).toBe(SIDEBAR_DRAWER_WIDTH);
    expect(drawer.style.maxWidth).toBe(SIDEBAR_DRAWER_MAX_WIDTH);
    expect(screen.getByText('FILE_EXPLORER')).toBeInTheDocument();
  });

  it('does not render the viewer slot when the URL has no file path', () => {
    renderLayout('/workspace/main');
    expect(screen.queryByText('FILE_VIEWER')).toBeNull();
  });

  it('renders the viewer slot in the sheet when the URL points at a file', () => {
    renderLayout('/workspace/main/foo/bar.md');
    expect(screen.getByText('FILE_VIEWER')).toBeInTheDocument();
  });

  it('unmounts the viewer when the close button is pressed (post-transition)', async () => {
    const user = userEvent.setup();
    renderLayout('/workspace/main/foo/bar.md');
    expect(screen.getByText('FILE_VIEWER')).toBeInTheDocument();
    const dialog = screen.getByRole('dialog', { name: /file preview/i });

    await user.click(screen.getByRole('button', { name: /close file/i }));

    // SlideOverlay defers unmount until after the exit transition (~220ms).
    // FILE_VIEWER text disappears synchronously because the parent conditionally
    // renders the children, so target the dialog element itself — its removal
    // is what actually exercises SlideOverlay's deferred-unmount path.
    await waitForElementToBeRemoved(dialog);
    expect(screen.queryByText('FILE_VIEWER')).toBeNull();
  });
});
