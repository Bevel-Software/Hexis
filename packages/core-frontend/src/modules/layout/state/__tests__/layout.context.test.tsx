import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LayoutContext, useLayout, type LayoutController } from '../layout.context';

function Consumer() {
  const { isExplorerCollapsed, isChatCollapsed } = useLayout();
  return (
    <div>
      <span data-testid="explorer">{String(isExplorerCollapsed)}</span>
      <span data-testid="chat">{String(isChatCollapsed)}</span>
    </div>
  );
}

describe('useLayout', () => {
  it('throws when used outside a provider', () => {
    expect(() => render(<Consumer />)).toThrow(
      /useLayout must be used within LayoutContext.Provider/,
    );
  });

  it('exposes the controller inside a provider', () => {
    const controller: LayoutController = {
      isExplorerCollapsed: false,
      isChatCollapsed: true,
      canToggleExplorer: true,
      canToggleChat: true,
      toggleExplorer: () => {},
      toggleChat: () => {},
    };
    render(
      <LayoutContext.Provider value={controller}>
        <Consumer />
      </LayoutContext.Provider>,
    );
    expect(screen.getByTestId('explorer').textContent).toBe('false');
    expect(screen.getByTestId('chat').textContent).toBe('true');
  });
});
