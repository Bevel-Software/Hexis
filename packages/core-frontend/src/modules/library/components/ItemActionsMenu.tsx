import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { MoreHorizontal } from 'lucide-react';
import { cn } from '../../../lib/utils';
import {
  IconButton,
  MenuItem,
  MenuPanel,
  useDismissableMenu,
  usePointerMenuPosition,
} from '../../../shared/components';

/**
 * One verb in a card's or a row's own menu.
 *
 * `label` is the word AND the item's accessible name, so the two can never
 * disagree — the icon beside it is decoration and carries no name of its own.
 */
export interface ItemAction {
  label: string;
  icon: ReactNode;
  /** What the item does. Absent on an item that states a fact (see `disabled`). */
  onSelect?(): void;
  /**
   * Draw the file tree's rule above this item. Access sits below it there and
   * in the Library nav's menu, because it changes who else can be here rather
   * than what is here — so `Share` carries it on a card too.
   */
  separated?: boolean;
  /**
   * The verb is not available and saying why is the point — "Requested" on a
   * plugin the caller has already asked to join, which is exactly what the
   * locked page shows in place of its button. Skipped by the arrow keys,
   * because focus on a disabled control is a dead end.
   */
  disabled?: boolean;
}

/** How far below the "…" button the menu opens, matching the file tree's gap. */
const MENU_GAP = 4;

/**
 * Every item the arrows may land on, in order. A DISABLED item is not a stop:
 * focus on a control that cannot act is a dead end the arrows cannot leave.
 * Filtered in JavaScript rather than with `:disabled` in the selector, which
 * the test DOM does not implement.
 */
function menuItemsOf(panel: HTMLElement | null): HTMLButtonElement[] {
  return Array.from(panel?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []).filter(
    (el) => !el.disabled,
  );
}

/**
 * A card or a row, plus the menu it carries.
 *
 * The frame exists because of one HTML fact: a card IS a `<button>` and a row
 * IS a `<button>`, so the menu's trigger cannot live inside either — a button
 * in a button is not markup. Same split `CardGrid` already makes for its
 * remove overlay: a wrapper takes the grid slot, the target keeps the whole
 * surface, and the second control is an absolutely-placed SIBLING of it.
 *
 * The trigger is quiet until it is wanted (`opacity`, so nothing shifts under
 * the cursor as the card lights up) and `focus-within` is what keeps that
 * honest for anyone who never hovers — the button is a real tab stop right
 * after the card whether or not it can be seen. A right-click anywhere on the
 * frame opens the same menu at the pointer, so the gesture people already use
 * in the file tree and the Library nav works here too.
 *
 * An EMPTY `actions` still gets the frame, and that is deliberate. What a row
 * can offer depends on answers that land after the first paint — the plugin
 * index, the workspace's KB directory — and a frame that appeared only once
 * they had would change the tree's shape under React, remounting the card or
 * row itself: anyone who had focused or was mid-click on it would lose it the
 * moment the catalog settled. So the wrapper is constant and only its contents
 * are conditional; with nothing to offer it carries no role, no label and no
 * button, and is a bare `<div>` around the thing it wraps.
 */
export function ItemMenuFrame({
  label,
  actions,
  className,
  buttonClassName,
  children,
}: {
  /** What was clicked, by name — the group's and the menu's accessible name. */
  label: string;
  actions: ItemAction[];
  /** The frame takes the wrapped element's place in its grid or list. */
  className?: string;
  /** Where the "…" sits: a card puts it in the corner, a row on the mid-line. */
  buttonClassName?: string;
  children: ReactNode;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  /** Where the menu is open, in viewport coordinates. `null` is closed. */
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const offered = actions.length > 0;

  function toggleFromButton() {
    // A trigger toggles. `useDismissableMenu` deliberately ignores clicks on
    // the control it was given, so closing on a second click is ours.
    if (at) {
      setAt(null);
      return;
    }
    const r = triggerRef.current?.getBoundingClientRect();
    setAt({ x: r?.left ?? 0, y: (r?.bottom ?? 0) + MENU_GAP });
  }

  return (
    <div
      role={offered ? 'group' : undefined}
      aria-label={offered ? label : undefined}
      className={cn('group/itemmenu relative grid min-w-0', className)}
      onContextMenu={
        offered
          ? (e: ReactMouseEvent) => {
              e.preventDefault();
              setAt({ x: e.clientX, y: e.clientY });
            }
          : undefined
      }
    >
      {children}
      {offered && (
        <IconButton
          ref={triggerRef}
          size={22}
          aria-label={`Actions for ${label}`}
          title={`Actions for ${label}`}
          aria-haspopup="menu"
          aria-expanded={at !== null}
          active={at !== null}
          className={cn(
            // `bg-surface`, because it floats over the card's own text.
            'absolute right-1.5 top-1.5 bg-surface opacity-0 transition-opacity',
            'group-hover/itemmenu:opacity-100 group-focus-within/itemmenu:opacity-100',
            at !== null && 'opacity-100',
            buttonClassName,
          )}
          onClick={toggleFromButton}
        >
          <MoreHorizontal size={14} />
        </IconButton>
      )}
      {at && offered && (
        <ItemActionsMenu
          x={at.x}
          y={at.y}
          label={label}
          actions={actions}
          onClose={() => setAt(null)}
          returnFocusTo={triggerRef}
        />
      )}
    </div>
  );
}

/**
 * The panel itself — the Library nav's menu (`PluginsSidebarMenu`) with the
 * items handed in rather than named inline, because a card, a row and a locked
 * row are three item lists and not three menus.
 *
 * Dismissal is `useDismissableMenu`'s, unchanged: outside click closes, Escape
 * closes and hands focus back to the "…" it came from. What this adds is the
 * INSIDE of the menu, which no menu in the app owned yet: opening moves focus
 * to the first verb, and the arrows (plus Home/End) walk the list, so the menu
 * can be driven without a pointer at all.
 *
 * Every other way out of the menu hands focus back the same way Escape does,
 * because all three end with the focused node gone: PICKING a verb (the menu
 * unmounts under the finger — an action that opens a dialog mounts it after
 * this and takes focus from there, which is what should happen), and TAB,
 * which the menu pattern treats as "close and carry on" — focus goes to the
 * "…" first so the browser's own Tab continues one step past it rather than
 * from the top of the document, where a removed node strands it.
 */
function ItemActionsMenu({
  x,
  y,
  label,
  actions,
  onClose,
  returnFocusTo,
}: {
  x: number;
  y: number;
  label: string;
  actions: ItemAction[];
  onClose(): void;
  returnFocusTo: RefObject<HTMLElement | null>;
}) {
  const ref = useDismissableMenu<HTMLDivElement>({ open: true, onClose, returnFocusTo });
  const pos = usePointerMenuPosition(ref, x, y);

  // Focus enters the menu with it. Without this the menu opens behind the
  // keyboard: Escape would work (the document listener sees it) but nothing
  // else would, and Tab would walk on to the next card.
  // `ref` is a stable `useRef` box, so this runs once per open.
  useEffect(() => {
    menuItemsOf(ref.current)[0]?.focus();
  }, [ref]);

  /** Close, and put focus back where the menu came from. See the docstring. */
  function closeAndReturn() {
    onClose();
    returnFocusTo.current?.focus();
  }

  function onKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    // Tab leaves the menu, so the menu goes — and deliberately WITHOUT
    // `preventDefault`: the browser reads the focused element after this
    // handler, so moving focus to the trigger here makes its own Tab land on
    // whatever follows the trigger, which is the next thing in the page.
    if (e.key === 'Tab') {
      closeAndReturn();
      return;
    }
    const items = menuItemsOf(ref.current);
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    let next: number;
    if (e.key === 'ArrowDown') next = (at + 1) % items.length;
    else if (e.key === 'ArrowUp') next = (at - 1 + items.length) % items.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = items.length - 1;
    else return;
    e.preventDefault();
    items[next]?.focus();
  }

  return (
    // Positioning stays with the caller — `MenuPanel` is presentation only, so
    // the fixed wrapper is ours, exactly as in the nav's menu and the tree's.
    <div
      ref={ref}
      className="fixed z-50"
      style={{ left: pos.left, top: pos.top }}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={onKeyDown}
    >
      <MenuPanel role="menu" aria-label={`Actions for ${label}`} className="min-w-[180px]">
        {actions.map((action) => (
          <Fragment key={action.label}>
            {action.separated && <div className="my-1 border-t border-line" />}
            <MenuItem
              role="menuitem"
              disabled={action.disabled}
              onClick={() => {
                action.onSelect?.();
                closeAndReturn();
              }}
            >
              <span className="flex items-center gap-2">
                {action.icon}
                {action.label}
              </span>
            </MenuItem>
          </Fragment>
        ))}
      </MenuPanel>
    </div>
  );
}
