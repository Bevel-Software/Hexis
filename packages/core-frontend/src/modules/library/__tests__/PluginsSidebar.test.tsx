import { describe, it, expect, vi, type Mock } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { PluginsSidebar, type PluginsSidebarProps } from '../components/PluginsSidebar';
import type { LibraryFilter } from '../utils/status';

/**
 * The Library nav: two lenses, the caller's teams (their own space first),
 * the two roots as trees. A pure view of the URL — `filter` in, intents out.
 */

function renderSidebar(over: Partial<PluginsSidebarProps> = {}) {
  const onSelect = vi.fn();
  const onFinishSetup = vi.fn();
  const props: PluginsSidebarProps = {
    filter: { kind: 'all' },
    onSelect,
    ownedCount: 2,
    ownedAttention: 0,
    personalPluginLabel: "Juan's Plugin",
    ungroupedCount: 1,
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

  it('heads the teams and the trees, and lists no plugins of its own', () => {
    renderSidebar();
    expect(screen.getByText('Your teams')).toBeInTheDocument();
    expect(screen.getByText('Full file trees')).toBeInTheDocument();
    expect(screen.queryByText('Plugins')).not.toBeInTheDocument();
    expect(screen.queryByText('All plugins')).not.toBeInTheDocument();
    expect(screen.queryByText('Library')).not.toBeInTheDocument();
  });

  it("leads the teams with the caller's own space, and lists it even when empty", () => {
    renderSidebar({ filter: { kind: 'ungrouped' }, ungroupedCount: 0 });
    const heading = screen.getByText('Your teams');
    const own = row(/^Juan's Plugin/);
    const first = row(/^Engineering/);
    expect(heading.compareDocumentPosition(own) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(own.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(own).toHaveAttribute('aria-current', 'true');
    expect(own).toHaveAccessibleName("Juan's Plugin");
  });

  it('renders the two trees it is handed under the trees heading, Skills before Plugins', () => {
    renderSidebar({
      skillsTree: <div data-testid="skills-tree">skills</div>,
      pluginsTree: <div data-testid="plugins-tree">plugins</div>,
    });
    const heading = screen.getByText('Full file trees');
    const skills = screen.getByTestId('skills-tree');
    const plugins = screen.getByTestId('plugins-tree');
    expect(heading.compareDocumentPosition(skills) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(skills.compareDocumentPosition(plugins) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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
      [/^Juan's Plugin/, { kind: 'ungrouped' }],
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

  it('offers a way to make a plugin from the trees heading', () => {
    const { onCreatePlugin } = renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'New plugin' }));
    expect(onCreatePlugin).toHaveBeenCalledTimes(1);
  });

  it('spells out Create a plugin when told the workspace is untouched — the `+` alone is hover-hidden', () => {
    const { onCreatePlugin } = renderSidebar({ canCreatePlugin: true });
    fireEvent.click(screen.getByRole('button', { name: 'Create a plugin' }));
    expect(onCreatePlugin).toHaveBeenCalledTimes(1);
  });

  it('says nothing about creating unless told to — the verdict is the layout\'s, and omitted means off', () => {
    renderSidebar({ canCreatePlugin: false });
    expect(screen.queryByRole('button', { name: 'Create a plugin' })).not.toBeInTheDocument();
    cleanup();
    renderSidebar({ canCreatePlugin: undefined });
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
