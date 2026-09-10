import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { PluginsSidebar, type PluginsSidebarProps } from '../components/PluginsSidebar';
import type { LibraryFilter } from '../utils/status';

/**
 * The Library nav: two lenses, the groups as the server lists them, the two
 * roots as trees. A pure view of the URL — `filter` in, intents out.
 */

function renderSidebar(over: Partial<PluginsSidebarProps> = {}) {
  const onSelect = vi.fn();
  const onFinishSetup = vi.fn();
  const props: PluginsSidebarProps = {
    filter: { kind: 'all' },
    onSelect,
    ownedCount: 2,
    ownedAttention: 0,
    teams: [
      { name: 'Engineering', count: 4, urgent: 0 },
      { name: 'GTM', count: 3, urgent: 2 },
      { name: 'Product', count: 0, urgent: 0 },
    ],
    attentionCount: 2,
    onFinishSetup,
    onCreatePlugin: vi.fn(),
    canCreatePlugin: false,
    ...over,
  };
  render(<PluginsSidebar {...props} />);
  return {
    onSelect,
    onFinishSetup,
    onCreatePlugin: props.onCreatePlugin as Mock,
  };
}

const row = (name: RegExp | string) => screen.getByRole('button', { name });

describe('PluginsSidebar', () => {
  // The remembered view is per-browser state; each test starts from a browser
  // that remembers nothing.
  beforeEach(() => window.localStorage.removeItem('bevel-library-sidebar-view'));

  it('leads with Everything, the Library home, and marks it current on the root', () => {
    renderSidebar({ filter: { kind: 'all' } });
    const rows = screen.getAllByRole('button');
    expect(rows[0]).toHaveAccessibleName('Everything');
    expect(row(/^Everything/)).toHaveAttribute('aria-current', 'true');
    expect(row(/^Owned by me/)).toHaveAttribute('aria-current', 'false');
  });

  it('lights no row on a page with no filter — an item page, a plugin page', () => {
    renderSidebar({ filter: null });
    for (const button of screen.getAllByRole('button')) {
      expect(button).not.toHaveAttribute('aria-current', 'true');
    }
  });

  it('offers two views under the lenses — Teams by default — and lists no plugins of its own', () => {
    renderSidebar();
    const tabs = screen.getByRole('tablist', { name: 'Sidebar view' });
    expect(within(tabs).getByRole('tab', { name: 'Groups' })).toHaveAttribute('aria-selected', 'true');
    expect(within(tabs).getByRole('tab', { name: 'Advanced' })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('tabpanel', { name: 'Groups' })).toBeInTheDocument();
    expect(screen.queryByText('Plugins')).not.toBeInTheDocument();
    expect(screen.queryByText('All plugins')).not.toBeInTheDocument();
    expect(screen.queryByText('Library')).not.toBeInTheDocument();
  });

  it("lists the groups in the server's order and nothing else — your own space is not a group", () => {
    renderSidebar({ filter: { kind: 'ungrouped' } });
    const panel = screen.getByRole('tabpanel', { name: 'Groups' });
    expect(within(panel).getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Engineering4',
      'GTM2',
      'Product',
    ]);
    // The own-space page lights no row: it is reached from Everything, not from here.
    expect(within(panel).queryByRole('button', { current: true })).toBeNull();
  });

  it('switches to the Advanced view, which holds the two trees — Skills before Plugins — and no team rows', () => {
    renderSidebar({
      skillsTree: <div data-testid="skills-tree">skills</div>,
      pluginsTree: <div data-testid="plugins-tree">plugins</div>,
    });
    // The other view stays MOUNTED and hidden — the trees keep their state
    // across a switch, and every tab's `aria-controls` names a real panel.
    expect(screen.getByTestId('skills-tree')).not.toBeVisible();
    expect(screen.getByRole('tab', { name: 'Advanced' })).toHaveAttribute('aria-controls', 'library-view-advanced');
    expect(document.getElementById('library-view-advanced')).not.toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Advanced' }));
    expect(screen.getByRole('tab', { name: 'Advanced' })).toHaveAttribute('aria-selected', 'true');
    const panel = screen.getByRole('tabpanel', { name: 'Advanced' });
    const skills = within(panel).getByTestId('skills-tree');
    const plugins = within(panel).getByTestId('plugins-tree');
    expect(skills.compareDocumentPosition(plugins) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // No heading over the trees: the tab already names the view.
    expect(within(panel).queryByText('Files on disk')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Engineering/ })).toBeNull();
    // The lenses belong to neither view and stay put.
    expect(row(/^Everything/)).toBeInTheDocument();
    expect(row(/^Owned by me/)).toBeInTheDocument();
  });

  it('remembers the view in the browser, and defaults to Teams when the browser remembers nothing', () => {
    renderSidebar();
    fireEvent.click(screen.getByRole('tab', { name: 'Advanced' }));
    expect(window.localStorage.getItem('bevel-library-sidebar-view')).toBe('advanced');
    cleanup();
    renderSidebar();
    expect(screen.getByRole('tab', { name: 'Advanced' })).toHaveAttribute('aria-selected', 'true');
    window.localStorage.removeItem('bevel-library-sidebar-view');
    cleanup();
    renderSidebar();
    expect(screen.getByRole('tab', { name: 'Groups' })).toHaveAttribute('aria-selected', 'true');
  });

  it('is one tab stop: the arrows move between the views and choose as they go, Home and End go to the ends', () => {
    renderSidebar();
    const teams = screen.getByRole('tab', { name: 'Groups' });
    const advanced = screen.getByRole('tab', { name: 'Advanced' });
    // Roving tabIndex: only the chosen tab is in the Tab order.
    expect(teams).toHaveAttribute('tabindex', '0');
    expect(advanced).toHaveAttribute('tabindex', '-1');

    teams.focus();
    fireEvent.keyDown(screen.getByRole('tablist', { name: 'Sidebar view' }), { key: 'ArrowRight' });
    expect(advanced).toHaveAttribute('aria-selected', 'true');
    expect(document.activeElement).toBe(advanced);
    expect(advanced).toHaveAttribute('tabindex', '0');
    expect(teams).toHaveAttribute('tabindex', '-1');

    fireEvent.keyDown(screen.getByRole('tablist', { name: 'Sidebar view' }), { key: 'ArrowRight' });
    expect(teams).toHaveAttribute('aria-selected', 'true'); // wraps
    fireEvent.keyDown(screen.getByRole('tablist', { name: 'Sidebar view' }), { key: 'End' });
    expect(advanced).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(screen.getByRole('tablist', { name: 'Sidebar view' }), { key: 'Home' });
    expect(teams).toHaveAttribute('aria-selected', 'true');
    expect(document.activeElement).toBe(teams);
  });

  it('answers a right-click on the switch with nothing — it is a control, not empty nav space', () => {
    const onContextMenu = vi.fn();
    renderSidebar({ onContextMenu });
    fireEvent.contextMenu(screen.getByRole('tab', { name: 'Advanced' }));
    fireEvent.contextMenu(screen.getByRole('tablist', { name: 'Sidebar view' }));
    expect(onContextMenu).not.toHaveBeenCalled();
  });

  it('marks the selected team current and leaves the others alone', () => {
    renderSidebar({ filter: { kind: 'team', group: 'GTM' } });
    expect(row(/^GTM/)).toHaveAttribute('aria-current', 'true');
    expect(row(/^Engineering/)).toHaveAttribute('aria-current', 'false');
    expect(row(/^Everything/)).toHaveAttribute('aria-current', 'false');
  });

  it("shows how much a team can use, in grey — and nothing at all for a team that can use nothing", () => {
    renderSidebar();
    expect(row(/^Engineering/)).toHaveAccessibleName('Engineering 4');
    expect(within(row(/^Engineering/)).getByText('4')).toHaveClass('text-ink-faint');
    // Never a grey 0.
    expect(row(/^Product/)).toHaveAccessibleName('Product');
  });

  it("turns a team's count orange when its plugins lock its members out of a skill", () => {
    renderSidebar();
    // GTM can use 3 things, but 2 links are broken for its members: orange
    // wins the slot — other people's problem outranks the inventory.
    expect(row(/^GTM/)).toHaveAccessibleName('GTM 2');
    const badge = within(row(/^GTM/)).getByText('2');
    expect(badge).toHaveClass('text-urgent');
    expect(badge).not.toHaveClass('text-wait');
  });

  it('emits the right LibraryFilter per row', () => {
    const { onSelect } = renderSidebar();
    const expected: [RegExp, LibraryFilter][] = [
      [/^Everything/, { kind: 'all' }],
      [/^Owned by me/, { kind: 'owned' }],
      [/^GTM/, { kind: 'team', group: 'GTM' }],
    ];
    for (const [name, filter] of expected) {
      onSelect.mockClear();
      fireEvent.click(row(name));
      expect(onSelect).toHaveBeenCalledWith(filter);
    }
  });

  it('two teams may not share a name, but a team may share one with a lens — rows stay distinct', () => {
    renderSidebar({ teams: [{ name: 'Everything', count: 1, urgent: 0 }] });
    const rows = screen.getAllByRole('button', { name: /^Everything/ });
    expect(rows).toHaveLength(2);
  });

  it('spells out Create a plugin in the Advanced view when told the workspace is untouched — the `+` alone is hover-hidden', () => {
    const { onCreatePlugin } = renderSidebar({ canCreatePlugin: true });
    fireEvent.click(screen.getByRole('tab', { name: 'Advanced' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create a plugin' }));
    expect(onCreatePlugin).toHaveBeenCalledTimes(1);
  });

  it('says nothing about creating unless told to — the verdict is the layout\'s, and omitted means off', () => {
    renderSidebar({ canCreatePlugin: false });
    fireEvent.click(screen.getByRole('tab', { name: 'Advanced' }));
    expect(screen.queryByRole('button', { name: 'Create a plugin' })).not.toBeInTheDocument();
    cleanup();
    window.localStorage.removeItem('bevel-library-sidebar-view');
    renderSidebar({ canCreatePlugin: undefined });
    fireEvent.click(screen.getByRole('tab', { name: 'Advanced' }));
    expect(screen.queryByRole('button', { name: 'Create a plugin' })).not.toBeInTheDocument();
  });

  it('shows the owned count in grey, and amber only when something waits on you', () => {
    renderSidebar({ ownedCount: 26, ownedAttention: 0 });
    expect(row(/^Owned by me/)).toHaveAccessibleName('Owned by me 26');

    cleanup();
    renderSidebar({ ownedCount: 26, ownedAttention: 1 });
    expect(row(/^Owned by me/)).toHaveAccessibleName('Owned by me 1');
    expect(within(row(/^Owned by me/)).getByText('1')).toHaveClass('text-wait');
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
