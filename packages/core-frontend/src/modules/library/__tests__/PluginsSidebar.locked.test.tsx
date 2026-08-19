import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { PluginsSidebar, type PluginsSidebarProps } from '../components/PluginsSidebar';

/**
 * The locked half of the nav: plugins the caller cannot read still appear, below
 * a break, with a lock where a count would be.
 *
 * Locked selection is a URL like any other — a locked row emits the SAME
 * `{ kind: 'group' }` intent as a readable one, and the plugin page decides which
 * view the caller gets. That is deliberate: one route per plugin means a locked
 * plugin can be linked to and bookmarked, and unlocking one changes nothing about
 * where it lives.
 */

function renderSidebar(over: Partial<PluginsSidebarProps> = {}) {
  const onSelect = vi.fn();
  const props: PluginsSidebarProps = {
    filter: { kind: 'all' },
    onSelect,
    plugins: [
      { plugin: 'Engineering', count: 4, attention: 0 },
      { plugin: 'GTM', count: 3, attention: 2 },
    ],
    lockedPlugins: ['Finance', 'Legal'],
    ownedCount: 2,
    ownedAttention: 0,
    personalPluginLabel: "Juan's Plugin",
    ungroupedCount: 1,
    attentionCount: 2,
    onFinishSetup: vi.fn(),
    onCreatePlugin: vi.fn(),
    canCreatePlugin: true,
    pluginsIndexActive: false,
    onOpenPluginsIndex: vi.fn(),

    ...over,
  };
  render(<PluginsSidebar {...props} />);
  return { onSelect };
}

const nav = () => screen.getByRole('navigation', { name: 'Library plugins' });

describe('PluginsSidebar: locked plugins', () => {
  it('names a locked row by its state, with no count in it', () => {
    renderSidebar();
    const finance = screen.getByRole('button', { name: 'Finance (locked)' });
    expect(finance).toBeInTheDocument();
    // A non-member cannot see inside to count anything, and never gets the
    // amber attention badge — there is nothing they could fix.
    expect(finance.textContent).toBe('Finance');
  });

  it('puts the locked rows last, after every plugin the caller is in', () => {
    renderSidebar();
    const labels = within(nav())
      .getAllByRole('button')
      .map((b) => b.getAttribute('aria-label') ?? b.textContent);
    expect(labels).toEqual([
      'All plugins',
      'Everything',
      'Owned by me2',
      'New plugin',
      // Your own space leads the plugins; the ones you cannot enter trail them.
      "Juan's Plugin1",
      'Engineering4',
      'GTM2',
      'Finance (locked)',
      'Legal (locked)',
    ]);
  });

  it('navigates to the plugin route on click, exactly like a readable plugin', () => {
    const { onSelect } = renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'Finance (locked)' }));
    expect(onSelect).toHaveBeenCalledWith({ kind: 'group', plugin: 'Finance' });
  });

  it('marks the locked row current when its plugin is the route', () => {
    renderSidebar({ filter: { kind: 'group', plugin: 'Finance' } });
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
    renderSidebar({ lockedPlugins: [] });
    expect(screen.queryByRole('button', { name: /\(locked\)$/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^GTM/ })).toBeInTheDocument();
  });
});
