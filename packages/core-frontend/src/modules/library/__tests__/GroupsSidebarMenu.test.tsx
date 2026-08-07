import { describe, it, expect, vi } from 'vitest';
import { createRef } from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { GroupsSidebarMenu, type GroupsSidebarMenuProps } from '../components/GroupsSidebarMenu';

/**
 * The Library nav's right-click menu.
 *
 * Two things are under test and they are not the same thing. The ITEMS are the
 * Library's own — a group is not a file, so this menu says `New group` where
 * the tree says `New folder` — but the BEHAVIOUR has to be the file tree's,
 * because a right-click that dismisses one way in Knowledge and another way in
 * Skills is two products in one window. Outside click closes, Escape closes,
 * Escape returns focus to the row (`useDismissableMenu`).
 */

function renderMenu(over: Partial<GroupsSidebarMenuProps> = {}) {
  const onClose = vi.fn();
  const props: GroupsSidebarMenuProps = {
    x: 140,
    y: 260,
    label: 'GTM',
    onClose,
    onAdd: vi.fn(),
    onCreateGroup: vi.fn(),
    onCopyLink: vi.fn(),
    onManageAccess: vi.fn(),
    ...over,
  };
  render(<GroupsSidebarMenu {...props} />);
  return { ...props, onClose };
}

const menu = () => screen.getByRole('menu');
const items = () =>
  within(menu())
    .getAllByRole('menuitem')
    .map((i) => i.textContent);

describe('GroupsSidebarMenu', () => {
  it('names itself after the row it was opened from', () => {
    renderMenu();
    expect(screen.getByRole('menu', { name: 'Actions for GTM' })).toBeInTheDocument();
  });

  it('opens at the pointer', () => {
    renderMenu();
    // The panel is presentation only, so the fixed wrapper is the caller's.
    const wrapper = menu().parentElement!;
    expect(wrapper).toHaveStyle({ left: '140px', top: '260px' });
  });

  /**
   * Create verbs first, copy next, access below the rule — the file tree's
   * order (`FileExplorer.tsx:232-287`), so the two menus have the same shape
   * even where they do not have the same words.
   */
  it('orders a full group menu the way the file tree orders its own', () => {
    renderMenu();
    expect(items()).toEqual(['Add a skill or tool', 'New group', 'Copy link', 'Manage access']);
  });

  it('renders only the verbs it was given. An absent one is not a disabled one', () => {
    // What a lens row gets: no folder behind it, so nothing to add to and no
    // access to manage.
    renderMenu({ onAdd: undefined, onManageAccess: undefined });
    expect(items()).toEqual(['New group', 'Copy link']);
  });

  it('keeps New group on the empty-space menu, where it is the only verb', () => {
    renderMenu({
      label: 'Library',
      onAdd: undefined,
      onCopyLink: undefined,
      onManageAccess: undefined,
    });
    expect(items()).toEqual(['New group']);
  });

  it.each([
    ['Add a skill or tool', 'onAdd'],
    ['New group', 'onCreateGroup'],
    ['Copy link', 'onCopyLink'],
    ['Manage access', 'onManageAccess'],
  ] as const)('runs %s and then closes', (name, key) => {
    const props = renderMenu();
    fireEvent.click(screen.getByRole('menuitem', { name }));
    expect(props[key]).toHaveBeenCalledTimes(1);
    // A menu that stayed open behind the sheet it just opened would be a second
    // thing to dismiss.
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on an outside click', () => {
    const { onClose } = renderMenu();
    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('stays open when the click is inside it', () => {
    const { onClose } = renderMenu();
    fireEvent.mouseDown(menu());
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes on Escape and hands focus back to the row', () => {
    const row = document.createElement('button');
    document.body.appendChild(row);
    const ref = createRef<HTMLElement>() as React.RefObject<HTMLElement | null>;
    ref.current = row;

    const { onClose } = renderMenu({ returnFocusTo: ref });
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
    // Otherwise focus is left on a node that just unmounted and the next Tab
    // starts from the top of the document.
    expect(document.activeElement).toBe(row);
    row.remove();
  });
});
