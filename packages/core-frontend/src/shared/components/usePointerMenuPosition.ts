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
    setPos({ left, top });
    // Moving the panel cannot change its size, so one measurement per open is
    // enough and this never feeds itself. `ref` is a stable `useRef` box, so
    // listing it changes nothing at runtime.
  }, [x, y, ref]);

  return pos;
}
