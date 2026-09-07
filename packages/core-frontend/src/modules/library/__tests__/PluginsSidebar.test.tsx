import { describe, it, expect, vi, type Mock } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { PluginsSidebar, type PluginsSidebarProps } from '../components/PluginsSidebar';
import type { LibraryFilter } from '../utils/status';

/**
 * The sidebar as a pure view: given a filter and counts, which row is current,
 * what its count slot says, and which intent a click emits. It owns no state
 * and no navigation, so nothing here needs a router.
 */

function renderSidebar(over: Partial<PluginsSidebarProps> = {}) {
  const onSelect = vi.fn();
  const onFinishSetup = vi.fn();
  const props: PluginsSidebarProps = {
    filter: { kind: 'all' },
    onSelect,
    plugins: [
      { plugin: 'Engineering', count: 4, attention: 0 },
      { plugin: 'GTM', count: 3, attention: 2 },
      { plugin: 'Product', count: 0, attention: 0 },
    ],
    lockedPlugins: [],
    ownedCount: 2,
    ownedAttention: 0,
    personalPluginLabel: "Juan's Plugin",
    ungroupedCount: 1,
    attentionCount: 2,
    onFinishSetup,
    onCreatePlugin: vi.fn(),
    canCreatePlugin: true,
    pluginsIndexActive: false,
    onOpenPluginsIndex: vi.fn(),

    ...over,
  };
  render(<PluginsSidebar {...props} />);
  return {
    onSelect,
    onFinishSetup,
    onCreatePlugin: props.onCreatePlugin as Mock,
    onOpenPluginsIndex: props.onOpenPluginsIndex as Mock,
  };
}

const row = (name: RegExp | string) => screen.getByRole('button', { name });

describe('PluginsSidebar', () => {
  it('shows a plugin by its label and navigates by its identity — locked rows too', () => {
    const { onSelect } = renderSidebar({
      plugins: [{ plugin: 'gtm', label: 'Go To Market', count: 3, attention: 0 }],
      lockedPlugins: [{ name: 'finance', label: 'Finance' }],
    });
    fireEvent.click(row(/^Go To Market/));
    expect(onSelect).toHaveBeenCalledWith({ kind: 'group', plugin: 'gtm' });
    expect(screen.queryByRole('button', { name: /^gtm/ })).toBeNull();

    fireEvent.click(row('Finance (locked)'));
    expect(onSelect).toHaveBeenCalledWith({ kind: 'group', plugin: 'finance' });
    expect(screen.queryByRole('button', { name: /^finance/ })).toBeNull();
  });

  it('two plugins wearing one label are still two rows, each navigating to its own identity', () => {
    // React tells on a list keyed by something two children share; the rows
    // are keyed by what they ARE, so it has nothing to say.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { onSelect } = renderSidebar({
        plugins: [
          { plugin: 'sales-eu', label: 'Sales', count: 1, attention: 0 },
          { plugin: 'sales-us', label: 'Sales', count: 2, attention: 0 },
        ],
      });
      const rows = screen.getAllByRole('button', { name: /^Sales/ });
      expect(rows).toHaveLength(2);
      fireEvent.click(rows[1]);
      expect(onSelect).toHaveBeenLastCalledWith({ kind: 'group', plugin: 'sales-us' });
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it('leads with All plugins. The Library opens there, so the nav starts there', () => {
    const { onOpenPluginsIndex } = renderSidebar();
    const rows = screen.getAllByRole('button');
    expect(rows[0]).toHaveAccessibleName('All plugins');
    fireEvent.click(rows[0]);
    expect(onOpenPluginsIndex).toHaveBeenCalledTimes(1);
  });

  it('marks All plugins current on the index, and nothing else', () => {
    renderSidebar({ filter: null, pluginsIndexActive: true });
    expect(row(/^All plugins/)).toHaveAttribute('aria-current', 'true');
    expect(row(/^Everything/)).toHaveAttribute('aria-current', 'false');
    expect(row(/^Owned by me/)).toHaveAttribute('aria-current', 'false');
  });

  it('keeps Everything as a lens of its own, since the root is the index now', () => {
    renderSidebar({ filter: { kind: 'all' } });
    expect(row(/^Everything/)).toHaveAttribute('aria-current', 'true');
    expect(row(/^All plugins/)).toHaveAttribute('aria-current', 'false');
  });

  it('heads the plugin rows with what they are: plugins', () => {
    renderSidebar();
    expect(screen.getByText('Plugins')).toBeInTheDocument();
    expect(screen.queryByText('Included in your MCP')).not.toBeInTheDocument();
  });

  it('renders the Skills tree it is handed right under All plugins, before the lenses', () => {
    renderSidebar({ skillsTree: <div data-testid="skills-tree">tree</div> });
    const tree = screen.getByTestId('skills-tree');
    const home = screen.getByRole('button', { name: 'All plugins' });
    const library = screen.getByText('Library');
    // Document order: All plugins → the tree → the Library heading.
    expect(home.compareDocumentPosition(tree) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(tree.compareDocumentPosition(library) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("leads the plugins with the caller's own space", () => {
    renderSidebar({ filter: { kind: 'ungrouped' } });
    expect(row(/^Juan's Plugin/)).toHaveAttribute('aria-current', 'true');
    expect(row(/^Owned by me/)).toHaveAttribute('aria-current', 'false');
  });

  it('offers a way to make a plugin', () => {
    const { onCreatePlugin } = renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'New plugin' }));
    expect(onCreatePlugin).toHaveBeenCalledTimes(1);
  });

  it('spells out Create a plugin while the MCP list is empty — the `+` alone is hover-hidden', () => {
    const { onCreatePlugin } = renderSidebar({ plugins: [] });
    fireEvent.click(screen.getByRole('button', { name: 'Create a plugin' }));
    expect(onCreatePlugin).toHaveBeenCalledTimes(1);
  });

  it('stands the create CTA down once a real plugin exists', () => {
    renderSidebar(); // default fixture has three plugins
    expect(screen.queryByRole('button', { name: 'Create a plugin' })).not.toBeInTheDocument();
  });

  it('stands the create CTA down when only locked plugins exist — someone already created them', () => {
    renderSidebar({ plugins: [], lockedPlugins: ['Ops'] });
    expect(screen.queryByRole('button', { name: 'Create a plugin' })).not.toBeInTheDocument();
  });

  it('stands the create CTA down for a non-admin, empty workspace or not', () => {
    renderSidebar({ plugins: [], lockedPlugins: [], canCreatePlugin: false });
    expect(screen.queryByRole('button', { name: 'Create a plugin' })).not.toBeInTheDocument();
  });

  it('says nothing about creating when the prop is omitted — the nav a host app already had', () => {
    // `canCreatePlugin` is optional so this public props type survives the
    // upgrade. Omitted must mean OFF, which is the nav exactly as it shipped.
    renderSidebar({ plugins: [], lockedPlugins: [], canCreatePlugin: undefined });
    expect(screen.queryByRole('button', { name: 'Create a plugin' })).not.toBeInTheDocument();
  });

  it('marks the selected plugin current and leaves the others alone', () => {
    renderSidebar({ filter: { kind: 'group', plugin: 'GTM' } });
    expect(row(/^GTM/)).toHaveAttribute('aria-current', 'true');
    expect(row(/^Engineering/)).toHaveAttribute('aria-current', 'false');
  });

  it('shows the attention count instead of the item count when something needs setup', () => {
    renderSidebar();
    // GTM: 3 items but 2 integrations need setup — amber wins the slot.
    expect(row(/^GTM/)).toHaveAccessibleName('GTM 2');
    expect(within(row(/^GTM/)).getByText('2')).toHaveClass('text-wait');
    expect(row(/^Engineering/)).toHaveAccessibleName('Engineering 4');
    // Never a grey 0: an empty plugin shows no count at all.
    expect(row(/^Product/)).toHaveAccessibleName('Product');
  });

  it('turns the count orange when members are locked out of a linked skill', () => {
    renderSidebar({
      plugins: [
        { plugin: 'GTM', count: 3, attention: 2, urgent: true },
        { plugin: 'Ops', count: 3, attention: 1, urgent: false },
      ],
    });
    // Blocking other people outranks a tool the reader has not set up.
    const gtm = within(row(/^GTM/)).getByText('2');
    expect(gtm).toHaveClass('text-urgent');
    expect(gtm).not.toHaveClass('text-wait');
    expect(within(row(/^Ops/)).getByText('1')).toHaveClass('text-wait');
  });

  it('emits the right LibraryFilter per row', () => {
    const { onSelect } = renderSidebar();
    const expected: [RegExp, LibraryFilter][] = [
      [/^Everything/, { kind: 'all' }],
      [/^Owned by me/, { kind: 'owned' }],
      [/^GTM/, { kind: 'group', plugin: 'GTM' }],
      [/^Juan's Plugin/, { kind: 'ungrouped' }],
    ];
    for (const [name, filter] of expected) {
      onSelect.mockClear();
      fireEvent.click(row(name));
      expect(onSelect).toHaveBeenCalledWith(filter);
    }
  });

  it("keeps the caller's own plugin listed even when it is empty", () => {
    // It is a PLACE, not a filtered view: a plugin you are always in does not
    // vanish because you have not put anything in it yet.
    renderSidebar({ ungroupedCount: 0 });
    expect(row(/^Juan's Plugin/)).toBeInTheDocument();
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
