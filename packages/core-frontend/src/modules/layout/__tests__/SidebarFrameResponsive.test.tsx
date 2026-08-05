import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  SIDEBAR_DRAWER_MAX_WIDTH,
  SIDEBAR_DRAWER_WIDTH,
  SidebarFrame,
} from '../components/SidebarFrame';
import {
  SIDEBAR_DEFAULT_WIDTH,
  setSidebarCollapsed,
  setSidebarWidth,
} from '../state/sidebar';

function setViewportWidth(width: number): void {
  const testWindow = window as typeof window & {
    happyDOM: { setInnerWidth(value: number): void };
  };
  testWindow.happyDOM.setInnerWidth(width);
}

function renderFrame(): HTMLElement {
  const { container } = render(
    <SidebarFrame label="Library groups">
      <button type="button">Engineering</button>
    </SidebarFrame>,
  );
  return container.querySelector('aside') as HTMLElement;
}

function renderFrameWithContainer() {
  return render(
    <SidebarFrame label="Library groups">
      <button type="button">Engineering</button>
    </SidebarFrame>,
  );
}

beforeEach(() => {
  setViewportWidth(1400);
  setSidebarCollapsed(false);
  setSidebarWidth(SIDEBAR_DEFAULT_WIDTH);
});

describe('SidebarFrame — narrow viewport', () => {
  it('starts collapsed and genuinely removes the sidebar from interaction', () => {
    setViewportWidth(375);
    const aside = renderFrame();

    expect(aside).toHaveStyle({ width: '0px' });
    expect(aside).toHaveAttribute('inert');
  });

  it('starts expanded at its stored width on a wide viewport', () => {
    setSidebarWidth(320);
    const aside = renderFrame();

    expect(aside).toHaveStyle({ width: '320px' });
    expect(aside).not.toHaveAttribute('inert');
  });

  it.each([
    [900, '0px', true],
    [901, `${SIDEBAR_DEFAULT_WIDTH}px`, false],
  ])('switches the sidebar at the exact %ipx boundary', (width, expectedWidth, inert) => {
    setViewportWidth(width);
    const aside = renderFrame();

    expect(aside).toHaveStyle({ width: expectedWidth });
    expect(aside.hasAttribute('inert')).toBe(inert);
  });

  it('collapses when the viewport crosses from wide to narrow', () => {
    const aside = renderFrame();

    act(() => setViewportWidth(375));

    expect(aside).toHaveStyle({ width: '0px' });
    expect(aside).toHaveAttribute('inert');
  });

  it('reopens when the viewport crosses from narrow to wide', () => {
    setViewportWidth(375);
    const aside = renderFrame();

    act(() => {
      // happy-dom initializes each MediaQueryList listener's transition state
      // on its first resize event; browsers already retain the initial match.
      window.dispatchEvent(new Event('resize'));
      setViewportWidth(1400);
    });

    expect(aside).toHaveStyle({ width: `${SIDEBAR_DEFAULT_WIDTH}px` });
    expect(aside).not.toHaveAttribute('inert');
  });

  it('keeps a manual narrow-screen open until another breakpoint transition', () => {
    setViewportWidth(375);
    const aside = renderFrame();

    act(() => setSidebarCollapsed(false));
    act(() => setSidebarWidth(260));

    expect(aside.style.width).toBe(SIDEBAR_DRAWER_WIDTH);
    expect(aside.style.maxWidth).toBe(SIDEBAR_DRAWER_MAX_WIDTH);
    expect(aside).not.toHaveAttribute('inert');
  });

  it.each(['File explorer', 'Library groups'])(
    'opens %s as the same modal drawer over a backdrop',
    (label) => {
      setViewportWidth(375);
      const { container } = render(
        <SidebarFrame label={label}>
          <button type="button">First destination</button>
          <button type="button">Last destination</button>
        </SidebarFrame>,
      );

      act(() => setSidebarCollapsed(false));

      const drawer = screen.getByRole('dialog', { name: label });
      expect(drawer).toHaveClass('fixed', 'z-50');
      expect(drawer.style.width).toBe(SIDEBAR_DRAWER_WIDTH);
      expect(drawer.style.maxWidth).toBe(SIDEBAR_DRAWER_MAX_WIDTH);
      expect(container.querySelector('[data-sidebar-backdrop]')).toBeInTheDocument();
      expect(screen.queryByRole('separator', { name: /resize/i })).toBeNull();
      expect(screen.getByRole('button', { name: 'First destination' })).toHaveFocus();
    },
  );

  it('closes the drawer from its backdrop', () => {
    setViewportWidth(375);
    const { container } = renderFrameWithContainer();
    act(() => setSidebarCollapsed(false));

    fireEvent.click(container.querySelector('[data-sidebar-backdrop]')!);

    expect(container.querySelector('aside')).toHaveAttribute('inert');
    expect(container.querySelector('[data-sidebar-backdrop]')).toBeNull();
  });

  it('closes the drawer with Escape', () => {
    setViewportWidth(375);
    const aside = renderFrame();
    act(() => setSidebarCollapsed(false));

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(aside).toHaveAttribute('inert');
  });

  it('keeps the existing wide behavior when matchMedia is unavailable', () => {
    const originalMatchMedia = window.matchMedia;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: undefined,
    });

    try {
      const aside = renderFrame();
      expect(aside).toHaveStyle({ width: `${SIDEBAR_DEFAULT_WIDTH}px` });
      expect(aside).not.toHaveAttribute('inert');
    } finally {
      Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        value: originalMatchMedia,
      });
    }
  });
});
