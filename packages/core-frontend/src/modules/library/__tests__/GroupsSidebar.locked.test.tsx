import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { GroupsSidebar, type GroupsSidebarProps } from '../components/GroupsSidebar';

/**
 * The locked half of the nav: groups the caller cannot read still appear, below
 * a break, with a lock where a count would be.
 *
 * Locked selection is a URL like any other — a locked row emits the SAME
 * `{ kind: 'group' }` intent as a readable one, and the group page decides which
 * view the caller gets. That is deliberate: one route per group means a locked
 * group can be linked to and bookmarked, and unlocking one changes nothing about
 * where it lives.
 */

function renderSidebar(over: Partial<GroupsSidebarProps> = {}) {
  const onSelect = vi.fn();
  const props: GroupsSidebarProps = {
    filter: { kind: 'all' },
    onSelect,
    groups: [
      { group: 'Engineering', count: 4, attention: 0 },
      { group: 'GTM', count: 3, attention: 2 },
    ],
    lockedGroups: ['Finance', 'Legal'],
    ownedCount: 2,
    ownedAttention: 0,
    personalGroupLabel: "Juan's Group",
    ungroupedCount: 1,
    attentionCount: 2,
    onFinishSetup: vi.fn(),
    onCreateGroup: vi.fn(),

    ...over,
  };
  render(<GroupsSidebar {...props} />);
  return { onSelect };
}

const nav = () => screen.getByRole('navigation', { name: 'Library groups' });

describe('GroupsSidebar — locked groups', () => {
  it('names a locked row by its state, with no count in it', () => {
    renderSidebar();
    const finance = screen.getByRole('button', { name: 'Finance (locked)' });
    expect(finance).toBeInTheDocument();
    // A non-member cannot see inside to count anything, and never gets the
    // amber attention badge — there is nothing they could fix.
    expect(finance.textContent).toBe('Finance');
  });

  it('puts the locked rows last, after every group the caller is in', () => {
    renderSidebar();
    const labels = within(nav())
      .getAllByRole('button')
      .map((b) => b.getAttribute('aria-label') ?? b.textContent);
    expect(labels).toEqual([
      'Owned by me2',
      'New group',
      // Your own space leads the groups; the ones you cannot enter trail them.
      "Juan's Group1",
      'Engineering4',
      'GTM2',
      'Finance (locked)',
      'Legal (locked)',
    ]);
  });

  it('navigates to the group route on click, exactly like a readable group', () => {
    const { onSelect } = renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'Finance (locked)' }));
    expect(onSelect).toHaveBeenCalledWith({ kind: 'group', group: 'Finance' });
  });

  it('marks the locked row current when its group is the route', () => {
    renderSidebar({ filter: { kind: 'group', group: 'Finance' } });
    expect(screen.getByRole('button', { name: 'Finance (locked)' })).toHaveAttribute(
      'aria-current',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Legal (locked)' })).toHaveAttribute(
      'aria-current',
      'false',
    );
  });

  it('renders no locked section at all when nothing is locked', () => {
    renderSidebar({ lockedGroups: [] });
    expect(screen.queryByRole('button', { name: /\(locked\)$/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^GTM/ })).toBeInTheDocument();
  });
});
