import { describe, it, expect } from 'vitest';
import { render, screen, waitForElementToBeRemoved } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { MobileChatLayout } from '../MobileChatLayout';
import { useLayout } from '../../state/layout.context';

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
  it('always renders the chat slot and hides the explorer until opened', () => {
    renderLayout('/');
    expect(screen.getByText('CHAT_PANEL')).toBeInTheDocument();
    expect(screen.queryByText('FILE_EXPLORER')).toBeNull();
  });

  it('exposes canToggleChat=false because chat is pinned full-screen', () => {
    renderLayout('/');
    expect(screen.getByTestId('can-toggle-chat').textContent).toBe('false');
  });

  it('mounts the explorer drawer when the hamburger toggles it open', async () => {
    const user = userEvent.setup();
    renderLayout('/');
    await user.click(screen.getByRole('button', { name: 'open-explorer' }));
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
