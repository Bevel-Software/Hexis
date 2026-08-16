import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, createEvent } from '@testing-library/react';
import { PluginsSidebar, type PluginsSidebarProps } from '../components/PluginsSidebar';

/**
 * Right-click in the Library nav, which has to answer the gesture the way
 * Knowledge's file tree does — the same one the platform has had since the tree
 * shipped (`FileExplorer.tsx:532`).
 *
 * The sidebar itself only REPORTS the click: it suppresses the browser menu,
 * reads the pointer and the row synchronously, and hands both up. Everything
 * about which verbs are true for a given row lives in `LibraryLayout`, because
 * that is where the plugin summaries are — so that is where those assertions
 * live too.
 */

function renderSidebar(over: Partial<PluginsSidebarProps> = {}) {
  const onContextMenu = vi.fn();
  const onSelect = vi.fn();
  const props: PluginsSidebarProps = {
    filter: { kind: 'all' },
    onSelect,
    plugins: [
      { plugin: 'Engineering', count: 4, attention: 0 },
      { plugin: 'GTM', count: 3, attention: 2 },
    ],
    lockedPlugins: ['Finance'],
    ownedCount: 2,
    ownedAttention: 0,
    personalPluginLabel: "Juan's Plugin",
    ungroupedCount: 1,
    attentionCount: 2,
    onFinishSetup: vi.fn(),
    onCreatePlugin: vi.fn(),
    pluginsIndexActive: false,
    onOpenPluginsIndex: vi.fn(),
    onContextMenu,
    ...over,
  };
  render(<PluginsSidebar {...props} />);
  return { onContextMenu, onSelect };
}

const nav = () => screen.getByRole('navigation', { name: 'Library plugins' });
const rightClick = (el: Element, at = { clientX: 120, clientY: 240 }) =>
  fireEvent.contextMenu(el, at);

describe('PluginsSidebar: right-click', () => {
  it('reports a plugin row with its filter, its name and the pointer', () => {
    const { onContextMenu } = renderSidebar();
    const gtm = screen.getByRole('button', { name: /^GTM/ });
    rightClick(gtm, { clientX: 88, clientY: 310 });

    expect(onContextMenu).toHaveBeenCalledTimes(1);
    expect(onContextMenu).toHaveBeenCalledWith({
      filter: { kind: 'group', plugin: 'GTM' },
      label: 'GTM',
      x: 88,
      y: 310,
      // The row itself, so Escape can hand focus back to it.
      row: gtm,
    });
  });

  it('reports a lens row by the filter it navigates to, not by its label', () => {
    const { onContextMenu } = renderSidebar();
    rightClick(screen.getByRole('button', { name: /^Owned by me/ }));
    expect(onContextMenu.mock.calls[0][0]).toMatchObject({
      filter: { kind: 'owned' },
      label: 'Owned by me',
    });

    rightClick(screen.getByRole('button', { name: /^Juan's Plugin/ }));
    expect(onContextMenu.mock.calls[1][0]).toMatchObject({
      filter: { kind: 'ungrouped' },
      label: "Juan's Plugin",
    });
  });

  /**
   * A locked row emits the same `{ kind: 'group' }` target a readable one does,
   * for the same reason its CLICK does: a plugin you are not in is still a place.
   * The label drops the "(locked)" suffix — that is the accessible name, not the
   * plugin's name, and the menu titles itself with the latter.
   */
  it('reports a locked row exactly like a readable plugin', () => {
    const { onContextMenu } = renderSidebar();
    rightClick(screen.getByRole('button', { name: 'Finance (locked)' }));
    expect(onContextMenu.mock.calls[0][0]).toMatchObject({
      filter: { kind: 'group', plugin: 'Finance' },
      label: 'Finance',
    });
  });

  /**
   * The home row has no `LibraryFilter` behind it — the index lists places, not
   * a slice of the catalog — so it reports `null` and gets the nav's own menu:
   * create a plugin, and none of the verbs that need a folder to point at.
   */
  it('reports the All plugins row with no filter, but with its own row and name', () => {
    const { onContextMenu } = renderSidebar();
    const home = screen.getByRole('button', { name: 'All plugins' });
    rightClick(home);
    expect(onContextMenu).toHaveBeenCalledTimes(1);
    expect(onContextMenu.mock.calls[0][0]).toMatchObject({
      filter: null,
      label: 'All plugins',
      row: home,
    });
  });

  it('reports the empty nav space as a target with no filter and no row', () => {
    const { onContextMenu } = renderSidebar();
    rightClick(nav());
    expect(onContextMenu).toHaveBeenCalledWith({
      filter: null,
      label: 'Library',
      x: 120,
      y: 240,
      row: null,
    });
  });

  /**
   * The nav wraps every row, so without `stopPropagation` a right-click on a
   * plugin would report the plugin AND then the empty space — and the layout
   * would render the empty-space menu, since the last call wins.
   */
  it('does not also report the nav when the click landed on a row', () => {
    const { onContextMenu } = renderSidebar();
    rightClick(screen.getByRole('button', { name: /^Engineering/ }));
    expect(onContextMenu).toHaveBeenCalledTimes(1);
    expect(onContextMenu.mock.calls[0][0].filter).toEqual({ kind: 'group', plugin: 'Engineering' });
  });

  it('suppresses the browser menu when the click is being handled', () => {
    renderSidebar();
    const gtm = screen.getByRole('button', { name: /^GTM/ });
    const event = createEvent.contextMenu(gtm);
    fireEvent(gtm, event);
    expect(event.defaultPrevented).toBe(true);
  });

  /**
   * With nobody listening there is nothing to open, and swallowing the gesture
   * would leave the user with no menu at all — worse than the browser's.
   */
  it("leaves the browser's own menu alone when no handler is wired", () => {
    renderSidebar({ onContextMenu: undefined });
    const gtm = screen.getByRole('button', { name: /^GTM/ });
    const event = createEvent.contextMenu(gtm);
    fireEvent(gtm, event);
    expect(event.defaultPrevented).toBe(false);
  });

  it('still navigates on a left click. The menu changes nothing about selection', () => {
    const { onSelect, onContextMenu } = renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: /^GTM/ }));
    expect(onSelect).toHaveBeenCalledWith({ kind: 'group', plugin: 'GTM' });
    expect(onContextMenu).not.toHaveBeenCalled();
  });

  it('marks the current row from the target it navigates to', () => {
    renderSidebar({ filter: { kind: 'group', plugin: 'GTM' } });
    expect(screen.getByRole('button', { name: /^GTM/ })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('button', { name: /^Engineering/ })).toHaveAttribute(
      'aria-current',
      'false',
    );
    expect(screen.getByRole('button', { name: /^Owned by me/ })).toHaveAttribute(
      'aria-current',
      'false',
    );
  });
});
