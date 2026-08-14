import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ResizableThreePaneLayout } from '../ResizableThreePaneLayout';
import { useLayout } from '../../state/layout.context';

function CollapseProbe() {
  const { isExplorerCollapsed, isChatCollapsed } = useLayout();
  return (
    <div>
      <span data-testid="probe-explorer">{String(isExplorerCollapsed)}</span>
      <span data-testid="probe-chat">{String(isChatCollapsed)}</span>
    </div>
  );
}

describe('ResizableThreePaneLayout', () => {
  it('renders header, explorer, viewer, and chat slots', () => {
    render(
      <ResizableThreePaneLayout
        header={<div data-testid="slot-header">HEADER</div>}
        explorer={<div data-testid="slot-explorer">EXPLORER</div>}
        viewer={<div data-testid="slot-viewer">VIEWER</div>}
        chat={<div data-testid="slot-chat">CHAT</div>}
      />,
    );
    expect(screen.getByTestId('slot-header')).toHaveTextContent('HEADER');
    expect(screen.getByTestId('slot-explorer')).toHaveTextContent('EXPLORER');
    expect(screen.getByTestId('slot-viewer')).toHaveTextContent('VIEWER');
    expect(screen.getByTestId('slot-chat')).toHaveTextContent('CHAT');
  });

  it('exposes a LayoutController via context with initial collapsed state of false', () => {
    render(
      <ResizableThreePaneLayout
        header={<CollapseProbe />}
        explorer={<div />}
        viewer={<div />}
        chat={<div />}
      />,
    );
    expect(screen.getByTestId('probe-explorer').textContent).toBe('false');
    expect(screen.getByTestId('probe-chat').textContent).toBe('false');
  });

  // The explorer left the plugin: it is the app's SIDEBAR now, sized by
  // `SidebarFrame` against a shared, persisted width rather than by a panel in
  // this layout's own persisted arrangement. So the plugin holds viewer + chat
  // and needs one panel separator, while the sidebar brings its own handle.
  it('separates the panels it still owns, and lets the sidebar bring its own handle', () => {
    const { container } = render(
      <ResizableThreePaneLayout
        header={<div />}
        explorer={<div />}
        viewer={<div />}
        chat={<div />}
      />,
    );
    expect(container.querySelectorAll('[data-separator]')).toHaveLength(1);
    expect(screen.getByRole('separator', { name: /resize/i })).toBeInTheDocument();
  });

  it('renders the explorer inside the sidebar frame, not as a panel', () => {
    render(
      <ResizableThreePaneLayout
        header={<div />}
        explorer={<div>tree</div>}
        viewer={<div />}
      />,
    );
    const aside = screen.getByRole('complementary', { name: /file explorer/i });
    expect(aside).toHaveTextContent('tree');
  });
});
