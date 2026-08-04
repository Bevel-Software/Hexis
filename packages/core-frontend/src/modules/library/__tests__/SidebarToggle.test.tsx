import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SidebarToggle } from '../components/SidebarToggle';
import { GroupsSidebar, type GroupsSidebarProps } from '../components/GroupsSidebar';

/**
 * Hiding the nav. Two halves, tested where each one lives: the button says
 * what it will do next, and the sidebar goes genuinely away rather than merely
 * narrow.
 *
 * The button is only ever found by its accessible name here — that name IS the
 * feature for anyone not looking at the screen, and the glyph is `aria-hidden`
 * precisely so the name is the only thing carrying it.
 */

function sidebar(over: Partial<GroupsSidebarProps> = {}) {
  const props: GroupsSidebarProps = {
    filter: { kind: 'all' },
    onSelect: vi.fn(),
    groups: [{ group: 'Engineering', count: 4, attention: 0 }],
    ownedCount: 2,
    ownedAttention: 0,
    personalGroupLabel: "Juan's Group",
    ungroupedCount: 0,
    attentionCount: 0,
    onFinishSetup: vi.fn(),
    onCreateGroup: vi.fn(),
    collapsed: false,
    ...over,
  };
  const { container } = render(<GroupsSidebar {...props} />);
  return container.querySelector('#library-sidebar')!;
}

describe('SidebarToggle', () => {
  it('offers to hide the sidebar while it is showing', () => {
    render(<SidebarToggle collapsed={false} onToggle={vi.fn()} />);
    const button = screen.getByRole('button', { name: 'Hide sidebar' });
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(button).toHaveAttribute('aria-controls', 'library-sidebar');
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

    // The label follows the prop, not the click: the layout owns the state.
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

describe('GroupsSidebar — collapsed', () => {
  it('stays reachable while showing', () => {
    const aside = sidebar({ collapsed: false });
    expect(aside).not.toHaveAttribute('inert');
    expect(screen.getByRole('button', { name: /^Engineering/ })).toBeInTheDocument();
  });

  it('goes inert when hidden, so tab order does not walk into a nav nobody can see', () => {
    const aside = sidebar({ collapsed: true });
    expect(aside).toHaveAttribute('inert');
  });

  it('no longer carries the Bevel brand block — the space is the toggle’s now', () => {
    sidebar();
    expect(screen.queryByText('Bevel')).not.toBeInTheDocument();
    expect(screen.queryByText('Skills & tools')).not.toBeInTheDocument();
  });
});
