import { describe, it, expect, vi, type Mock } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { GroupsSidebar, type GroupsSidebarProps } from '../components/GroupsSidebar';
import type { LibraryFilter } from '../utils/status';

/**
 * The sidebar as a pure view: given a filter and counts, which row is current,
 * what its count slot says, and which intent a click emits. It owns no state
 * and no navigation, so nothing here needs a router.
 */

function renderSidebar(over: Partial<GroupsSidebarProps> = {}) {
  const onSelect = vi.fn();
  const onFinishSetup = vi.fn();
  const props: GroupsSidebarProps = {
    filter: { kind: 'all' },
    onSelect,
    groups: [
      { group: 'Engineering', count: 4, attention: 0 },
      { group: 'GTM', count: 3, attention: 2 },
      { group: 'Product', count: 0, attention: 0 },
    ],
    lockedGroups: [],
    ownedCount: 2,
    ownedAttention: 0,
    personalGroupLabel: "Juan's Group",
    ungroupedCount: 1,
    attentionCount: 2,
    onFinishSetup,
    onCreateGroup: vi.fn(),
    collapsed: false,
    ...over,
  };
  render(<GroupsSidebar {...props} />);
  return { onSelect, onFinishSetup, onCreateGroup: props.onCreateGroup as Mock };
}

const row = (name: RegExp | string) => screen.getByRole('button', { name });

describe('GroupsSidebar', () => {
  it('carries no All groups row — the index is a breadcrumb destination now', () => {
    renderSidebar();
    expect(screen.queryByRole('button', { name: /^All groups/ })).not.toBeInTheDocument();
  });

  it('carries no Everything row — the Library already lands on everything', () => {
    renderSidebar();
    expect(screen.queryByRole('button', { name: /^Everything/ })).not.toBeInTheDocument();
  });

  it('heads the group rows with what the list is: the set in your MCP', () => {
    renderSidebar();
    expect(screen.getByText('Included in your MCP')).toBeInTheDocument();
  });

  it("leads the groups with the caller's own space", () => {
    renderSidebar({ filter: { kind: 'ungrouped' } });
    expect(row(/^Juan's Group/)).toHaveAttribute('aria-current', 'true');
    expect(row(/^Owned by me/)).toHaveAttribute('aria-current', 'false');
  });

  it('offers a way to make a group', () => {
    const { onCreateGroup } = renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'New group' }));
    expect(onCreateGroup).toHaveBeenCalledTimes(1);
  });

  it('marks the selected group current and leaves the others alone', () => {
    renderSidebar({ filter: { kind: 'group', group: 'GTM' } });
    expect(row(/^GTM/)).toHaveAttribute('aria-current', 'true');
    expect(row(/^Engineering/)).toHaveAttribute('aria-current', 'false');
  });

  it('shows the attention count instead of the item count when something needs setup', () => {
    renderSidebar();
    // GTM: 3 items but 2 integrations need setup — amber wins the slot.
    expect(row(/^GTM/)).toHaveAccessibleName('GTM 2');
    expect(row(/^Engineering/)).toHaveAccessibleName('Engineering 4');
    // Never a grey 0: an empty group shows no count at all.
    expect(row(/^Product/)).toHaveAccessibleName('Product');
  });

  it('emits the right LibraryFilter per row', () => {
    const { onSelect } = renderSidebar();
    const expected: [RegExp, LibraryFilter][] = [
      [/^Owned by me/, { kind: 'owned' }],
      [/^GTM/, { kind: 'group', group: 'GTM' }],
      [/^Juan's Group/, { kind: 'ungrouped' }],
    ];
    for (const [name, filter] of expected) {
      onSelect.mockClear();
      fireEvent.click(row(name));
      expect(onSelect).toHaveBeenCalledWith(filter);
    }
  });

  it("keeps the caller's own group listed even when it is empty", () => {
    // It is a PLACE, not a filtered view: a group you are always in does not
    // vanish because you have not put anything in it yet.
    renderSidebar({ ungroupedCount: 0 });
    expect(row(/^Juan's Group/)).toBeInTheDocument();
  });

  it('shows the owned count in grey, and amber only when something waits on you', () => {
    renderSidebar({ ownedCount: 26, ownedAttention: 0 });
    expect(row(/^Owned by me/)).toHaveAccessibleName('Owned by me 26');

    cleanup();
    renderSidebar({ ownedCount: 26, ownedAttention: 1 });
    expect(row(/^Owned by me/)).toHaveAccessibleName('Owned by me 1');
  });

  it('sends the setup footer to Connect', () => {
    const { onFinishSetup } = renderSidebar();
    fireEvent.click(row(/integrations need setup/));
    expect(onFinishSetup).toHaveBeenCalledTimes(1);
  });

  it('hides the setup footer when nothing needs setup', () => {
    renderSidebar({ attentionCount: 0 });
    expect(screen.queryByRole('button', { name: /needs? setup/ })).not.toBeInTheDocument();
  });
});
