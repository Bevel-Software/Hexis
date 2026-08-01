import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { GroupsSidebar, type GroupsSidebarProps } from '../components/GroupsSidebar';
import type { LibraryFilter } from '../utils/status';

/**
 * The sidebar as a pure view: given a filter and counts, which row is current,
 * what its count slot says, and which intent a click emits. It owns no state
 * and no navigation, so nothing here needs a router.
 */

function renderSidebar(over: Partial<GroupsSidebarProps> = {}) {
  const onSelect = vi.fn();
  const onOpenGroupsIndex = vi.fn();
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
    groupsIndexActive: false,
    onOpenGroupsIndex,
    ownedCount: 2,
    ungroupedCount: 1,
    attentionCount: 2,
    onFinishSetup,
    ...over,
  };
  render(<GroupsSidebar {...props} />);
  return { onSelect, onOpenGroupsIndex, onFinishSetup };
}

const row = (name: RegExp | string) => screen.getByRole('button', { name });

describe('GroupsSidebar', () => {
  it('renders an All groups row under the Groups heading', () => {
    renderSidebar();
    expect(row(/^All groups/)).toBeInTheDocument();
    expect(row(/^All groups/)).toHaveAttribute('aria-current', 'false');
  });

  it('marks All groups current when the index is the route', () => {
    renderSidebar({ filter: null, groupsIndexActive: true });
    expect(row(/^All groups/)).toHaveAttribute('aria-current', 'true');
    expect(row(/^Everything/)).toHaveAttribute('aria-current', 'false');
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
    const { onSelect, onOpenGroupsIndex } = renderSidebar();
    const expected: [RegExp, LibraryFilter][] = [
      [/^Owned by me/, { kind: 'owned' }],
      [/^Everything/, { kind: 'all' }],
      [/^GTM/, { kind: 'group', group: 'GTM' }],
      [/^Yours alone/, { kind: 'ungrouped' }],
    ];
    for (const [name, filter] of expected) {
      onSelect.mockClear();
      fireEvent.click(row(name));
      expect(onSelect).toHaveBeenCalledWith(filter);
    }
    // The index row is a different intent — it is not a gallery filter.
    fireEvent.click(row(/^All groups/));
    expect(onOpenGroupsIndex).toHaveBeenCalledTimes(1);
  });

  it('hides Yours alone when nothing is ungrouped', () => {
    renderSidebar({ ungroupedCount: 0 });
    expect(screen.queryByRole('button', { name: /^Yours alone/ })).not.toBeInTheDocument();
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
