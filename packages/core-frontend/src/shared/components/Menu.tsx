import type { ButtonHTMLAttributes, HTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

/**
 * A dropdown panel and its rows. Implements the prototype's `.ctxmenu`,
 * `.dotmenu`, `.cmenu` and `.pmenu`, which are one component wearing four
 * class names.
 *
 * The app currently re-derives this panel in at least EIGHT places with four
 * different radius/shadow pairs: `rounded-lg shadow-lg` (ManageAccessDialog),
 * `rounded shadow-lg` (AdminRolesPage), `rounded shadow-md` (AdminMenu,
 * PrHeaderOverflowMenu), `rounded-md shadow-lg` (AppSwitcher),
 * `rounded-md shadow-xl` (ReviewPanel), `rounded border … shadow-lg`
 * (EditorTabs). That drift is the reason this primitive exists.
 *
 * MenuPanel is presentation only — it does not portal, trap focus, or own
 * open state. Positioning stays with the caller, because the existing menus
 * anchor in four different ways (fixed to a measured rect, absolute to a
 * relative parent, or fixed to the viewport edge).
 */

export type MenuPanelProps = HTMLAttributes<HTMLDivElement>;

export function MenuPanel({ className, children, ...rest }: MenuPanelProps) {
  return (
    <div
      className={cn(
        'min-w-[200px] rounded-lg border border-line bg-surface p-1.5 shadow-overlay',
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

/**
 * `aria-disabled` is styled the same as `disabled`, and is the spelling to
 * reach for when the item must still be HOVERABLE and FOCUSABLE — a native
 * `disabled` button suppresses pointer events on most engines, which takes its
 * `title` tooltip with it, and drops the item out of the tab order so the
 * keyboard user never learns it exists. It does not block activation on its
 * own: an `aria-disabled` item's `onClick` must return early.
 */
export interface MenuItemProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: 'default' | 'danger';
  /** Visual checked/current state. Set `aria-checked`/`aria-current` yourself. */
  active?: boolean;
  /** Right-aligned adornment: a check, a lock, a shortcut hint. */
  trailing?: React.ReactNode;
}

export function MenuItem({
  tone = 'default',
  active = false,
  trailing,
  className,
  children,
  type = 'button',
  ...rest
}: MenuItemProps) {
  return (
    <button
      type={type}
      className={cn(
        'flex w-full items-center gap-2 rounded-sm px-2.5 py-2 text-left text-ui',
        'transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        'aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:hover:bg-transparent',
        tone === 'danger'
          ? 'text-danger hover:bg-danger-soft'
          // The aria-disabled text override is tone-local because the hover it
          // undoes is: only the default tone brightens to `text-ink`, and a
          // disabled row that still lights up on hover reads as usable.
          : 'text-ink-muted hover:bg-hover hover:text-ink aria-disabled:hover:text-ink-muted',
        active && 'font-medium text-ink',
        className,
      )}
      {...rest}
    >
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {trailing && <span className="flex-none text-ink-faint">{trailing}</span>}
    </button>
  );
}

/** A small uppercase section heading inside a menu (the prototype's `.menu-label`). */
export function MenuLabel({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'mt-1.5 border-t border-line px-2.5 pt-2.5 pb-1.5 text-label text-ink-faint',
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}
