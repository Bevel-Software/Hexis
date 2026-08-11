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
    canCreateGroup: true,
    groupsIndexActive: false,
    onOpenGroupsIndex: vi.fn(),

    ...over,
  };
  render(<GroupsSidebar {...props} />);
  return {
    onSelect,
    onFinishSetup,
    onCreateGroup: props.onCreateGroup as Mock,
    onOpenGroupsIndex: props.onOpenGroupsIndex as Mock,
  };
}

const row = (name: RegExp | string) => screen.getByRole('button', { name });

describe('GroupsSidebar', () => {
  it('leads with All groups. The Library opens there, so the nav starts there', () => {
    const { onOpenGroupsIndex } = renderSidebar();
    const rows = screen.getAllByRole('button');
    expect(rows[0]).toHaveAccessibleName('All groups');
    fireEvent.click(rows[0]);
    expect(onOpenGroupsIndex).toHaveBeenCalledTimes(1);
  });

  it('marks All groups current on the index, and nothing else', () => {
    renderSidebar({ filter: null, groupsIndexActive: true });
    expect(row(/^All groups/)).toHaveAttribute('aria-current', 'true');
    expect(row(/^Everything/)).toHaveAttribute('aria-current', 'false');
    expect(row(/^Owned by me/)).toHaveAttribute('aria-current', 'false');
  });

  it('keeps Everything as a lens of its own, since the root is the index now', () => {
    renderSidebar({ filter: { kind: 'all' } });
    expect(row(/^Everything/)).toHaveAttribute('aria-current', 'true');
    expect(row(/^All groups/)).toHaveAttribute('aria-current', 'false');
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

  it('spells out Create a group while the MCP list is empty — the `+` alone is hover-hidden', () => {
    const { onCreateGroup } = renderSidebar({ groups: [] });
    fireEvent.click(screen.getByRole('button', { name: 'Create a group' }));
    expect(onCreateGroup).toHaveBeenCalledTimes(1);
  });

  it('stands the create CTA down once a real group exists', () => {
    renderSidebar(); // default fixture has three groups
    expect(screen.queryByRole('button', { name: 'Create a group' })).not.toBeInTheDocument();
  });

  it('stands the create CTA down when only locked groups exist — someone already created them', () => {
    renderSidebar({ groups: [], lockedGroups: ['Ops'] });
    expect(screen.queryByRole('button', { name: 'Create a group' })).not.toBeInTheDocument();
  });

  it('stands the create CTA down for a non-admin, empty workspace or not', () => {
    renderSidebar({ groups: [], lockedGroups: [], canCreateGroup: false });
    expect(screen.queryByRole('button', { name: 'Create a group' })).not.toBeInTheDocument();
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
      [/^Everything/, { kind: 'all' }],
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
