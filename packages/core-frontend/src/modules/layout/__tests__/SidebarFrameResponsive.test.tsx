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
  setSidebarNarrow,
  setSidebarWidth,
  useSidebar,
} from '../state/sidebar';

/**
 * Cross the narrow breakpoint. happy-dom answers `matchMedia` out of
 * `innerWidth`, so moving the viewport is how a test reaches the drawer
 * layout — there is no CSS engine here to do it for us.
 */
function setViewportWidth(width: number): void {
  const testWindow = window as typeof window & {
    happyDOM: { setInnerWidth(value: number): void };
  };
  testWindow.happyDOM.setInnerWidth(width);
}

/** Mount a frame and hand back the `<aside>` — what most assertions here are about. */
function renderFrame(): HTMLElement {
  const { container } = render(
    <SidebarFrame label="Library groups">
      <button type="button">Engineering</button>
    </SidebarFrame>,
  );
  return container.querySelector('aside') as HTMLElement;
}

/**
 * The same mount, keeping the whole render result. The backdrop is a SIBLING
 * of the aside rather than a child, so a test that needs it cannot get there
 * from the element `renderFrame` returns.
 */
function renderFrameWithContainer() {
  return render(
    <SidebarFrame label="Library groups">
      <button type="button">Engineering</button>
    </SidebarFrame>,
  );
}

beforeEach(() => {
  setViewportWidth(1400);
  // The sidebar store is module state, so the breakpoint it last settled on
  // outlives the component. Reset it with the rest, or a test that mounts at
  // phone width inherits "already narrow" from its predecessor and the frame
  // treats the mount as a no-op instead of a crossing.
  setSidebarNarrow(false);
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

  /**
   * The invariant the store's paired write exists to hold, watched from a
   * subscriber across every snapshot the frame's mount and two crossings
   * produce. A snapshot saying "narrow" while the nav is still showing is a
   * drawer nobody opened: it paints over the page for a frame, and its focus
   * trap fires on the way past. So the two facts have to land together.
   *
   * Only mount and crossings are probed — once the user reopens the nav by
   * hand at phone width, narrow-and-showing is exactly the drawer, not a
   * glitch.
   */
  it('never publishes a narrow breakpoint with a still-showing sidebar', () => {
    const seen: Array<{ narrow: boolean; collapsed: boolean }> = [];
    /** Records every sidebar snapshot it is rendered for, in order. */
    function Probe() {
      const { narrow, collapsed } = useSidebar();
      seen.push({ narrow, collapsed });
      return null;
    }

    setViewportWidth(375);
    render(
      <>
        <Probe />
        <SidebarFrame label="Library groups">
          <button type="button">Engineering</button>
        </SidebarFrame>
      </>,
    );
    act(() => setViewportWidth(1400));
    act(() => setViewportWidth(375));

    expect(seen.length).toBeGreaterThan(1);
    expect(seen.filter((s) => s.narrow && !s.collapsed)).toEqual([]);
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
