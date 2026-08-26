import { useLayoutEffect, useState, type RefObject } from 'react';

/** Minimum inset from a viewport edge, and the gap left when a menu flips above the pointer. */
const MENU_MARGIN = 8;
const MENU_GAP = 4;

/** Where a pointer-anchored panel should paint, in viewport coordinates. */
export interface PointerMenuPosition {
  left: number;
  top: number;
}

/**
 * Places a pointer-anchored menu so the whole panel stays on screen.
 *
 * `MenuPanel` is presentation only and leaves positioning to its caller, which
 * is the right call for a primitive but leaves every pointer-anchored menu to
 * solve the same geometry. Three of them solved it three ways:
 * `ManageAccessDialog`'s `AnchoredMenu` measures and flips, `EditorTabs`
 * clamped, and the file tree pinned its panel straight to `clientX/clientY`.
 *
 * The tree is the one that hurt. A folder's menu is nine rows and about 300px
 * tall, so a right-click anywhere in the lower quarter of the sidebar drew it
 * downward off the bottom of the window, and being `position: fixed` there was
 * no way back to the rows below the fold: the page will not scroll to a fixed
 * box, and the wheel scrolls the tree out from under a menu that stays put.
 * `Manage access` is one of those rows, and for a folder it is the only route
 * to access control in the product.
 *
 * Down and to the right of the pointer stays the default, because that is what
 * every desktop shell does and it leaves the pointer on the first row, which is
 * never destructive. A panel that will not fit below flips above the pointer
 * instead, keeping a small gap: the gap is not cosmetic, since a flip that put
 * the panel's bottom edge exactly on the pointer would park the cursor on the
 * last row, and in the tree's menu that row is `Delete`. Fitting neither way
 * means the window is shorter than the menu, and the panel then sits against
 * the bottom margin, which keeps its top rows reachable and loses only the
 * bottom ones it could not have shown anyway.
 *
 * Pass the ref the panel already carries, the one from `useDismissableMenu`, so
 * both hooks share a single box. Measuring in a layout effect means the browser
 * paints the placed position once instead of flashing the unplaced one.
 */
export function usePointerMenuPosition<T extends HTMLElement>(
  ref: RefObject<T | null>,
  x: number,
  y: number,
): PointerMenuPosition {
  // The pre-measurement value is the pointer itself, so the first render is
  // exactly where these menus used to open and the layout effect corrects it
  // before paint.
  const [pos, setPos] = useState<PointerMenuPosition>({ left: x, top: y });

  useLayoutEffect(() => {
    const place = () => {
      const el = ref.current;
      if (!el) return;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const left = Math.max(MENU_MARGIN, Math.min(x, window.innerWidth - w - MENU_MARGIN));
      let top: number;
      if (y + h <= window.innerHeight - MENU_MARGIN) {
        top = y;
      } else if (y - MENU_GAP - h >= MENU_MARGIN) {
        top = y - MENU_GAP - h;
      } else {
        top = Math.max(MENU_MARGIN, window.innerHeight - MENU_MARGIN - h);
      }
      // Keep the previous object when nothing moved. `place` runs again on
      // every resize, and a fresh object each time would re-render for nothing.
      setPos((prev) => (prev.left === left && prev.top === top ? prev : { left, top }));
    };
    place();
    // A menu still open across a resize would otherwise keep a placement
    // measured against a window that no longer exists. Dragging a window edge
    // closes it first, because that is a mousedown outside the panel, but
    // zooming, entering fullscreen and OS window snapping all resize without
    // one, and the panel would be left hanging off the new viewport.
    //
    // `ref` is in the deps because it is read here. It is a stable `useRef`
    // box, so listing it changes nothing at runtime.
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [x, y, ref]);

  return pos;
}
