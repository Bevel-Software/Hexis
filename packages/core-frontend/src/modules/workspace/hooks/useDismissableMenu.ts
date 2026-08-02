import { useEffect, useRef, type RefObject } from 'react';

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
 * Returns the ref to put on the panel.
 */
export function useDismissableMenu<T extends HTMLElement>({
  open,
  onClose,
  /** The control that opened the menu. Clicks on it are ignored (its own
   *  handler toggles), and Escape hands focus back to it. */
  returnFocusTo,
}: {
  open: boolean;
  onClose: () => void;
  returnFocusTo?: RefObject<HTMLElement | null>;
}): RefObject<T | null> {
  const panelRef = useRef<T>(null);

  useEffect(() => {
    if (!open) return;

    function onPointerDown(e: MouseEvent) {
      const target = e.target as Node;
      if (panelRef.current?.contains(target)) return;
      // A click on the trigger is the trigger's business — closing here too
      // would make a toggle button close-then-reopen on a single click.
      if (returnFocusTo?.current?.contains(target)) return;
      onClose();
    }

    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      // Stops window-level Escape handlers from also acting on this key. It
      // does NOT protect against a `<Dialog>` hosting the menu — Dialog binds
      // on `document` too, and same-node listeners are unaffected by
      // stopPropagation. Nothing here mounts a menu inside a dialog; if
      // something ever does, the fix is `useModalLayer`, not a third
      // listener.
      e.stopPropagation();
      onClose();
      returnFocusTo?.current?.focus();
    }

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose, returnFocusTo]);

  return panelRef;
}
