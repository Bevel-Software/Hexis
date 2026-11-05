import { useEffect, useRef, type RefObject } from 'react';
import { useModalLayer } from './useModalLayer';
import { useLatestRef } from './useLatestRef';

/**
 * The behaviour `MenuPanel` deliberately does not provide.
 *
 * Its own docstring is explicit: "MenuPanel is presentation only — it does not
 * portal, trap focus, or own open state." That is the right call for a
 * primitive (the app's menus anchor in four different ways), but it leaves
 * every caller to re-implement the same three things. The prototype dismisses
 * all of its menus on an outside click and on Escape (proto:4255-4273), and a
 * menu you can only close by picking something is a trap for anyone driving
 * the app from the keyboard.
 *
 * So: outside-click closes, Escape closes, and Escape returns focus to
 * whatever opened the menu — otherwise focus is left on a node that just
 * unmounted and the next Tab starts from the top of the document.
 *
 * The hook owns two contracts its callers used to carry:
 *
 * - **It is a modal layer.** An open menu registers on the modal-layer stack,
 *   and its Escape acts only while the menu is the TOPMOST layer. That is
 *   what makes Escape peel one layer at a time in every composition: a menu
 *   inside a `<Dialog>` closes before the dialog (the dialog's own Escape
 *   guard sees it is not topmost), and two menus open at once — reachable by
 *   keyboard, where no mousedown dismisses the first — close one per press,
 *   newest first, instead of both on one press. Outside-click is different on
 *   purpose: clicking away is "dismiss everything light-weight", so it stays
 *   unguarded.
 * - **`onClose` may be a fresh arrow every render.** The hook mirrors it into
 *   a ref itself, so its document listeners subscribe once for the life of
 *   the open menu. Callers must not wrap it in their own ref-plus-stable-
 *   callback scaffolding — that pattern's drift is exactly what this replaces.
 *
 * Returns the ref to put on the panel.
 */
export interface DismissableMenuOptions {
  open: boolean;
  /** Close the menu. May be a fresh arrow each render — the hook mirrors it. */
  onClose: () => void;
  /**
   * The control that opened the menu. Clicks on it are ignored (its own
   * handler toggles), and Escape hands focus back to it. A stable ref.
   */
  returnFocusTo?: RefObject<HTMLElement | null>;
}

export function useDismissableMenu<T extends HTMLElement>({
  open,
  onClose,
  returnFocusTo,
}: DismissableMenuOptions): RefObject<T | null> {
  const panelRef = useRef<T>(null);
  const onCloseRef = useLatestRef(onClose);
  const isTop = useModalLayer(open);

  useEffect(() => {
    if (!open) return;

    function onPointerDown(e: MouseEvent) {
      const target = e.target as Node;
      if (panelRef.current?.contains(target)) return;
      // A click on the trigger is the trigger's business — closing here too
      // would make a toggle button close-then-reopen on a single click.
      if (returnFocusTo?.current?.contains(target)) return;
      onCloseRef.current();
    }

    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      // Only the topmost layer owns this Escape. Same-node `document`
      // listeners are unaffected by stopPropagation, so without this guard a
      // second open menu — or the `<Dialog>` hosting this one — would act on
      // the same keypress. Listeners run in subscription order (oldest
      // first), so every layer below the top returns here and exactly one
      // closes per press.
      if (!isTop()) return;
      e.stopPropagation();
      onCloseRef.current();
      returnFocusTo?.current?.focus();
    }

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, isTop, returnFocusTo, onCloseRef]);

  return panelRef;
}
