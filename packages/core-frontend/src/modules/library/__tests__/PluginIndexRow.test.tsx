import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { Badge } from '../../../shared/components';
import { PluginIndexRow } from '../components/PluginIndexRow';

/**
 * A plugin row's RIGHT EDGE — everything that is not the name.
 *
 * The bug: the `Owner` chip travelled with the name, through
 * `NameWithBadges`, and the counts travelled with `ListRow`'s `meta`. Two
 * groups, two lines, two vertical alignments. On the plugins index every row
 * with a description is two lines tall, so the chip sat up on the name's line
 * on the LEFT while "2 skills · 0 tools" sat centred on the RIGHT, and neither
 * lined up with the other or with the row.
 *
 * The rule now is one line at the edge: chips, counts, state. `ListRow`
 * already owns the group that does it (`ml-auto flex flex-none items-center`),
 * so what these assert is that everything trailing is IN that one group —
 * which is what makes "on one line, right-aligned, centred against the row"
 * true by construction rather than by three components agreeing.
 */

/**
 * The row's trailing group: the one element that holds everything at the
 * edge. Found through the counts, which every plugin row has, rather than by
 * a class — the group is `ListRow`'s and its class list is `ListRow`'s to
 * change.
 */
function trailingGroup(counts: string): HTMLElement {
  return screen.getByText(counts).parentElement as HTMLElement;
}

describe('the trailing controls on a plugin row', () => {
  const COUNTS = '2 skills · 0 tools';

  it('puts the chip, the counts and the state in ONE group', () => {
    render(
      <PluginIndexRow
        label="Company Handbook"
        badge={<Badge>Owner</Badge>}
        description="Run by Admin"
        meta={COUNTS}
        trailing={<Badge>Locked</Badge>}
        onOpen={vi.fn()}
      />,
    );

    const group = trailingGroup(COUNTS);
    expect(within(group).getByText('Owner')).toBeInTheDocument();
    expect(within(group).getByText('Locked')).toBeInTheDocument();
    // In reading order: what the plugin is to you, how much is in it, where
    // your access stands.
    expect(
      [...group.children].map((child) => child.textContent),
    ).toEqual(['Owner', COUNTS, 'Locked']);
  });

  it('holds that group on one centred line, right-aligned', () => {
    render(
      <PluginIndexRow
        label="Company Handbook"
        badge={<Badge>Owner</Badge>}
        description="Run by Admin"
        meta={COUNTS}
        onOpen={vi.fn()}
      />,
    );

    const group = trailingGroup(COUNTS);
    // `ml-auto` is the right-alignment, `items-center` the centring, and
    // `flex-none` is what stops the group being squeezed into a second line
    // by a long name. No `flex-wrap`: one line is the whole point.
    expect(group.className).toContain('ml-auto');
    expect(group.className).toContain('items-center');
    expect(group.className).toContain('flex-none');
    expect(group.className).not.toContain('flex-wrap');
    // And the row centres it against ITSELF, so the height of the title
    // block is not the group's business.
    const row = group.parentElement as HTMLElement;
    expect(row.className).toContain('items-center');
  });

  /**
   * The reported case, exactly: "Company Handbook" over "Run by Admin" is a
   * two-line title block, and the pill used to ride the first of those lines.
   */
  it('does not move when the title block is two lines tall', () => {
    const { rerender } = render(
      <PluginIndexRow
        label="Company Handbook"
        badge={<Badge>Owner</Badge>}
        meta={COUNTS}
        onOpen={vi.fn()}
      />,
    );
    const oneLine = trailingGroup(COUNTS);
    expect(within(oneLine).getByText('Owner')).toBeInTheDocument();
    const shape = oneLine.className;

    rerender(
      <PluginIndexRow
        label="Company Handbook"
        badge={<Badge>Owner</Badge>}
        description="Run by Admin, Olga Ivanova and Juan Perez"
        meta={COUNTS}
        onOpen={vi.fn()}
      />,
    );
    const twoLines = trailingGroup(COUNTS);
    // Same group, same classes, and the chip is still in it: the description
    // grew the title block and changed nothing at the edge.
    expect(twoLines.className).toBe(shape);
    expect(within(twoLines).getByText('Owner')).toBeInTheDocument();
    expect(screen.getByText('Run by Admin, Olga Ivanova and Juan Perez')).toBeInTheDocument();
  });

  it('keeps the trailing room clear for the menu that rides the same line', () => {
    // The `…` is a SIBLING of the row button, positioned on the row's
    // mid-line — the same line the group is centred on — but it is out of the
    // flex flow, so the row reserves its width rather than letting it paint
    // over the counts.
    render(
      <PluginIndexRow
        label="Company Handbook"
        badge={<Badge>Owner</Badge>}
        meta={COUNTS}
        actions={[{ label: 'Share', icon: null, onSelect: vi.fn() }]}
        onOpen={vi.fn()}
      />,
    );
    const row = trailingGroup(COUNTS).parentElement as HTMLElement;
    expect(row.className).toContain('pr-10');
    // Centred on the row's mid-line, which is the line the group is on.
    const menu = screen.getByRole('button', { name: 'Actions for Company Handbook' });
    expect(menu.className).toContain('top-1/2');
    expect(menu.className).toContain('-translate-y-1/2');
    // …and it really is outside the row, or reserving room for it would be
    // reserving room twice.
    expect(row).not.toContainElement(menu);
  });

  it('grows no trailing group at all on a row with nothing to put in one', () => {
    render(<PluginIndexRow label="Company Handbook" onOpen={vi.fn()} />);
    expect(screen.queryByText('Owner')).toBeNull();
  });
});
