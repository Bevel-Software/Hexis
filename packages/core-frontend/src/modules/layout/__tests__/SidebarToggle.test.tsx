import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { SidebarToggle } from '../components/SidebarToggle';
import { SIDEBAR_DOM_ID, SidebarFrame } from '../components/SidebarFrame';
import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  setSidebarCollapsed,
  setSidebarWidth,
} from '../state/sidebar';

/**
 * Hiding the nav, and sizing it. Two halves, tested where each one lives: the
 * button says what it will do next, and the frame goes genuinely away rather
 * than merely narrow.
 *
 * The button is only ever found by its accessible name here — that name IS the
 * feature for anyone not looking at the screen, and the glyph is `aria-hidden`
 * precisely so the name is the only thing carrying it.
 */

beforeEach(() => {
  setSidebarCollapsed(false);
  setSidebarWidth(SIDEBAR_DEFAULT_WIDTH);
});

function frame() {
  const { container } = render(
    <SidebarFrame label="Library groups">
      <button type="button">Engineering</button>
    </SidebarFrame>,
  );
  return container.querySelector(`#${SIDEBAR_DOM_ID}`) as HTMLElement;
}

describe('SidebarToggle', () => {
  it('offers to hide the sidebar while it is showing', () => {
    render(<SidebarToggle collapsed={false} onToggle={vi.fn()} />);
    const button = screen.getByRole('button', { name: 'Hide sidebar' });
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(button).toHaveAttribute('aria-controls', SIDEBAR_DOM_ID);
  });

  it('offers to show it again once hidden', () => {
    render(<SidebarToggle collapsed onToggle={vi.fn()} />);
    const button = screen.getByRole('button', { name: 'Show sidebar' });
    expect(button).toHaveAttribute('aria-expanded', 'false');
  });

  it('reports the click and keeps no state of its own', () => {
    const onToggle = vi.fn();
    const { rerender } = render(<SidebarToggle collapsed={false} onToggle={onToggle} />);
    fireEvent.click(screen.getByRole('button', { name: 'Hide sidebar' }));
    expect(onToggle).toHaveBeenCalledTimes(1);

    // The label follows the prop, not the click: the store owns the state.
    expect(screen.getByRole('button', { name: 'Hide sidebar' })).toBeInTheDocument();
    rerender(<SidebarToggle collapsed onToggle={onToggle} />);
    expect(screen.getByRole('button', { name: 'Show sidebar' })).toBeInTheDocument();
  });

  it('draws one glyph, and hides it from the accessible name', () => {
    const { container } = render(<SidebarToggle collapsed={false} onToggle={vi.fn()} />);
    const svg = container.querySelector('svg')!;
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    // The panel outline plus its filled left rail — the shape of the thing it
    // toggles, which is why there is a `path` and not just a `rect`.
    expect(container.querySelectorAll('svg rect')).toHaveLength(1);
    expect(container.querySelectorAll('svg path')).toHaveLength(1);
  });
});

describe('SidebarFrame — collapsed', () => {
  it('stays reachable while showing', () => {
    const aside = frame();
    expect(aside).not.toHaveAttribute('inert');
    expect(screen.getByRole('button', { name: 'Engineering' })).toBeInTheDocument();
  });

  it('goes inert when hidden, so tab order does not walk into a nav nobody can see', () => {
    setSidebarCollapsed(true);
    expect(frame()).toHaveAttribute('inert');
  });

  // A handle you can drag while the thing it sizes is at zero width would be
  // sizing something invisible (proto:98).
  it('withdraws the drag handle while hidden', () => {
    render(
      <SidebarFrame label="Library groups">
        <span>x</span>
      </SidebarFrame>,
    );
    expect(screen.getByRole('separator', { name: /resize/i })).toBeInTheDocument();
    act(() => setSidebarCollapsed(true));
    expect(screen.queryByRole('separator', { name: /resize/i })).toBeNull();
  });
});

describe('SidebarFrame — resize', () => {
  function grip() {
    render(
      <SidebarFrame label="Library groups">
        <span>x</span>
      </SidebarFrame>,
    );
    return screen.getByRole('separator', { name: /resize/i });
  }

  // A separator you can only drag is a control half the people cannot use.
  it('resizes from the keyboard, in both directions', () => {
    const separator = grip();
    fireEvent.keyDown(separator, { key: 'ArrowRight' });
    expect(separator).toHaveAttribute('aria-valuenow', String(SIDEBAR_DEFAULT_WIDTH + 8));
    fireEvent.keyDown(separator, { key: 'ArrowLeft' });
    expect(separator).toHaveAttribute('aria-valuenow', String(SIDEBAR_DEFAULT_WIDTH));
  });

  it('takes a bigger step with shift held', () => {
    const separator = grip();
    fireEvent.keyDown(separator, { key: 'ArrowRight', shiftKey: true });
    expect(separator).toHaveAttribute('aria-valuenow', String(SIDEBAR_DEFAULT_WIDTH + 32));
  });

  it('goes back to the default on Home, and on a double-click', () => {
    const separator = grip();
    fireEvent.keyDown(separator, { key: 'ArrowRight', shiftKey: true });
    fireEvent.keyDown(separator, { key: 'Home' });
    expect(separator).toHaveAttribute('aria-valuenow', String(SIDEBAR_DEFAULT_WIDTH));

    fireEvent.keyDown(separator, { key: 'ArrowLeft', shiftKey: true });
    fireEvent.doubleClick(separator);
    expect(separator).toHaveAttribute('aria-valuenow', String(SIDEBAR_DEFAULT_WIDTH));
  });

  // Clamped rather than free: below the minimum the names stop being readable,
  // and above the maximum the nav competes with the document for the page.
  it('stops at the ends of the range', () => {
    const separator = grip();
    for (let i = 0; i < 40; i += 1) {
      fireEvent.keyDown(separator, { key: 'ArrowLeft', shiftKey: true });
    }
    expect(separator).toHaveAttribute('aria-valuenow', String(SIDEBAR_MIN_WIDTH));
    for (let i = 0; i < 40; i += 1) {
      fireEvent.keyDown(separator, { key: 'ArrowRight', shiftKey: true });
    }
    expect(separator).toHaveAttribute('aria-valuenow', String(SIDEBAR_MAX_WIDTH));
  });
});

/**
 * The lock a drag puts on the whole document, and getting it back off.
 *
 * `cursor` and `user-select` go on `document.body` — outside React's tree, so
 * nothing unmounts them for us. Collapsing takes the separator away mid-drag
 * and the `pointerup` that would have ended the drag never arrives, which is
 * how the lock used to outlive the drag that set it and leave the entire app
 * un-selectable under a resize cursor with no way back.
 */
describe('SidebarFrame — drag cleanup', () => {
  beforeEach(() => {
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });

  function startDrag() {
    const { unmount } = render(
      <SidebarFrame label="Library groups">
        <span>x</span>
      </SidebarFrame>,
    );
    const separator = screen.getByRole('separator', { name: /resize/i });
    // The frame captures the pointer so a drag survives an iframe in the main
    // column; happy-dom has no implementation to capture with.
    separator.setPointerCapture = () => {};
    fireEvent.pointerDown(separator, { button: 0, pointerId: 1 });
    return { separator, unmount };
  }

  const locked = () =>
    document.body.style.cursor === 'col-resize' && document.body.style.userSelect === 'none';

  it('locks the document while the drag is live, and lets go on pointerup', () => {
    const { separator } = startDrag();
    expect(locked()).toBe(true);
    fireEvent.pointerUp(separator, { pointerId: 1 });
    expect(locked()).toBe(false);
    expect(document.body.style.cursor).toBe('');
  });

  it('lets go when a collapse takes the separator away mid-drag', () => {
    startDrag();
    expect(locked()).toBe(true);
    act(() => setSidebarCollapsed(true));
    expect(locked()).toBe(false);
  });

  // The other half of the same bug: ending a drag by collapsing has to FORGET
  // it too, or the sidebar coming back re-applies a lock nobody asked for.
  it('does not re-lock the document when the sidebar comes back', () => {
    startDrag();
    act(() => setSidebarCollapsed(true));
    act(() => setSidebarCollapsed(false));
    expect(locked()).toBe(false);
  });

  // The third way out, and the one with nothing else to fall back on: a route
  // change takes the whole frame away mid-drag. No pointerup, no collapse, and
  // `document.body` is not React's to tidy — only the cleanup gets it back.
  it('lets go when the frame unmounts mid-drag', () => {
    const { unmount } = startDrag();
    expect(locked()).toBe(true);
    unmount();
    expect(locked()).toBe(false);
    expect(document.body.style.cursor).toBe('');
  });
});
