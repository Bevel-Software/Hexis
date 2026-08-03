import { useSyncExternalStore } from 'react';

/**
 * The app's ONE sidebar: how wide it is, and whether it is showing.
 *
 * Knowledge and Skills & Tools do not have a sidebar each. The prototype makes
 * that literal — a single `<aside class="side">` (proto:1530) that two
 * renderers fill (proto:2961, proto:3584) — and this store is the platform's
 * version of the same claim. Drag it wider in Knowledge and it is wider in
 * Skills, because it is the same nav in the same place holding a different
 * list. Two independent widths would make switching apps move furniture.
 *
 * It lives in `layout` rather than beside either surface for the same reason
 * `shared/theme/measure.ts` does: the measure belongs to neither.
 *
 * WIDTH persists, COLLAPSED does not, and the split is deliberate. A width is
 * a preference — you set it once because your folder names are long, and
 * having to redo that every morning would be the app forgetting something you
 * told it. Hiding the nav is a "give me the page for a minute" gesture, so a
 * reload brings it back rather than stranding you on a navless app hunting for
 * the button that returns it.
 */

/** proto:4328-4329 — 212px default, and the range the drag is clamped to. */
export const SIDEBAR_DEFAULT_WIDTH = 212;
export const SIDEBAR_MIN_WIDTH = 180;
export const SIDEBAR_MAX_WIDTH = 460;

const WIDTH_STORAGE_KEY = 'bevel.sidebarWidth';

export const clampSidebarWidth = (w: number): number =>
  Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, Math.round(w)));

/**
 * Storage is best-effort throughout: Safari's private mode throws on
 * `localStorage` access, and a sidebar that cannot remember its width is a far
 * better outcome than an app that will not boot.
 */
function readStoredWidth(): number {
  try {
    const raw = window.localStorage.getItem(WIDTH_STORAGE_KEY);
    if (!raw) return SIDEBAR_DEFAULT_WIDTH;
    const parsed = Number.parseInt(raw, 10);
    // Clamped rather than trusted: the bounds may have changed since it was
    // written, and a hand-edited value should not be able to hide the nav.
    return Number.isFinite(parsed) ? clampSidebarWidth(parsed) : SIDEBAR_DEFAULT_WIDTH;
  } catch {
    return SIDEBAR_DEFAULT_WIDTH;
  }
}

let collapsed = false;
let instant = false;
let width = typeof window === 'undefined' ? SIDEBAR_DEFAULT_WIDTH : readStoredWidth();
// One frozen object per state, so `useSyncExternalStore` can compare by
// identity. Returning a fresh `{ collapsed, width }` from the snapshot would
// re-render every subscriber on every unrelated store read, and React would
// (rightly) warn about an unstable snapshot.
let snapshot: SidebarState = { collapsed, width, instant };

export interface SidebarState {
  collapsed: boolean;
  width: number;
  /**
   * Whether the CURRENT collapsed value arrived without a gesture, and so must
   * not be performed. Toggling the nav is something you did and deserves the
   * 240ms; the welcome page hiding it for the length of a greeting is not, and
   * animating that reads as the nav flinching on the way in and opening by
   * itself on the way out.
   */
  instant: boolean;
}

const listeners = new Set<() => void>();

function emit(): void {
  snapshot = { collapsed, width, instant };
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The toolbar button. A gesture, so it always animates. */
export function toggleSidebar(): void {
  collapsed = !collapsed;
  instant = false;
  emit();
}

/**
 * Direct set — the toolbar toggle's target, and how tests reset the module.
 *
 * @param instantly true when the change must not be performed: the nav simply
 *   is, or is not, in the next frame. `instant` rides along on the snapshot
 *   rather than being cleared on a timer, because the next change is what
 *   makes it stale — and every writer states its own intent.
 */
export function setSidebarCollapsed(value: boolean, instantly = false): void {
  if (value === collapsed) return;
  collapsed = value;
  instant = instantly;
  emit();
}

/**
 * @param persist false while a drag is in flight. A pointermove fires dozens
 *   of times a second and every write is synchronous; the committed width is
 *   what is worth remembering, so the drag writes on mouseup.
 */
export function setSidebarWidth(value: number, persist = true): void {
  const next = clampSidebarWidth(value);
  if (next === width) return;
  width = next;
  emit();
  if (!persist) return;
  try {
    window.localStorage.setItem(WIDTH_STORAGE_KEY, String(next));
  } catch {
    /* see readStoredWidth */
  }
}

/** Writes the current width without changing it — ends a drag. */
export function commitSidebarWidth(): void {
  try {
    window.localStorage.setItem(WIDTH_STORAGE_KEY, String(width));
  } catch {
    /* see readStoredWidth */
  }
}

export function useSidebar(): SidebarState {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    // Server/prerender: the default, since there is no storage to read.
    () => DEFAULT_SNAPSHOT,
  );
}

const DEFAULT_SNAPSHOT: SidebarState = {
  collapsed: false,
  width: SIDEBAR_DEFAULT_WIDTH,
  instant: false,
};
