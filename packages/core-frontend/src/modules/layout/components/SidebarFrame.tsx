import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '../../../lib/utils';
import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  commitSidebarWidth,
  setSidebarCollapsed,
  setSidebarNarrow,
  setSidebarWidth,
  useSidebar,
} from '../state/sidebar';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { NARROW_QUERY } from '../breakpoints';
import { useModalLayer } from '../../../shared/components/useModalLayer';

/**
 * The `aria-controls` target for the top bar's toggle, which renders in a
 * different subtree. One id because there is only ever one sidebar mounted —
 * the two surfaces never appear at once.
 */
export const SIDEBAR_DOM_ID = 'app-sidebar';

/** The old Knowledge drawer's phone measure: most of the screen, with a
 * visible strip of backdrop left as an obvious tap target. */
export const SIDEBAR_DRAWER_WIDTH = '85vw';
export const SIDEBAR_DRAWER_MAX_WIDTH = '24rem';

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The app's nav spine — the prototype's `.side` + `.resizer` + `.side-inner`
 * (proto:85-104, proto:4328-4370).
 *
 * ONE frame, filled by whichever surface you are on: the group list in Skills
 * & Tools, the file tree in Knowledge. They were two components with two
 * different backgrounds, two paddings and only one of them resizable, which is
 * two products wearing one logo. The prototype has a single `<aside>` and two
 * renderers, and this is that — the contents are `children`, everything about
 * being a sidebar is here.
 *
 * Collapsing is a WIDTH change on the frame, never a layout change on the
 * contents: the inner column keeps its own explicit width and is clipped, so
 * the rows slide out intact instead of reflowing to nothing on the way. The
 * border goes transparent rather than away — a border that stops existing
 * would jump the main column by a pixel at the end of a 240ms animation.
 *
 * `inert` is what makes "hidden" true rather than merely narrow. Zero width
 * still leaves every row focusable and still reads it out, so a keyboard user
 * would tab into a nav nobody can see. Clipping is a picture; `inert` is the
 * fact.
 */
export function SidebarFrame({
  children,
  label,
  header,
}: {
  children: ReactNode;
  /** Names the region and its resize handle, e.g. `Library groups`. */
  label: string;
  /**
   * Pinned above `children`, outside whatever list the surface is holding.
   *
   * A SLOT rather than a component this frame names, because the frame is the
   * app's consistency layer and must stay domain-agnostic: what belongs at the
   * top of the nav is the composing surface's decision, not the sidebar's.
   * Both surfaces pass the connect-your-agent reminder — which is what makes
   * it one pill in one place across Knowledge and Skills — but the frame does
   * not know that, and the next thing to go there costs no edit here.
   */
  header?: ReactNode;
}) {
  // `narrow` comes off the store rather than straight off `viewportNarrow`
  // below, because the store is where it lands in the same write as
  // `collapsed` (see `setSidebarNarrow`). Reading the raw query here instead
  // would reintroduce the render this frame is careful not to have: narrow
  // viewport, sidebar not yet collapsed, drawer briefly open.
  const { collapsed, width, instant, narrow } = useSidebar();
  const viewportNarrow = useMediaQuery(NARROW_QUERY);
  const [dragging, setDragging] = useState(false);
  const asideRef = useRef<HTMLElement>(null);
  const drawerOpen = narrow && !collapsed;
  const isTopModalLayer = useModalLayer(drawerOpen);

  // This frame owns the breakpoint because there is only ever one sidebar
  // mounted. The store ignores a repeat of the value it already holds, so a
  // sidebar the user reopened at phone width stays open until the next
  // crossing (or navigation), and a pre-collapsed desktop mount is left alone
  // rather than mistaken for a crossing.
  useEffect(() => {
    setSidebarNarrow(viewportNarrow);
  }, [viewportNarrow]);

  // A narrow sidebar covers the page rather than taking width from it. Treat
  // that presentation as a modal drawer: pull focus inside, keep Tab inside,
  // let Escape dismiss only the topmost modal layer, then return focus to the
  // toolbar toggle that opened it. Desktop remains a plain complementary nav.
  useEffect(() => {
    if (!drawerOpen) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const aside = asideRef.current;
    (aside?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR) ?? aside)?.focus?.();

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (!isTopModalLayer()) return;
        e.stopPropagation();
        setSidebarCollapsed(true);
        return;
      }
      if (e.key !== 'Tab' || !aside) return;
      const focusable = Array.from(
        aside.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      );
      if (focusable.length === 0) {
        e.preventDefault();
        aside.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === aside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previouslyFocused?.focus?.();
    };
  }, [drawerOpen, isTopModalLayer]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (collapsed || e.button !== 0) return;
      e.preventDefault();
      // Pointer capture rather than document listeners: it keeps the drag
      // alive over an iframe or a cross-origin embed in the main column, which
      // a mousemove on `document` silently loses.
      e.currentTarget.setPointerCapture(e.pointerId);
      setDragging(true);
    },
    [collapsed],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging) return;
      const left = asideRef.current?.getBoundingClientRect().left ?? 0;
      // Measured from the sidebar's own left edge, not from a start offset, so
      // the handle cannot drift away from the cursor over a long drag.
      setSidebarWidth(e.clientX - left, false);
    },
    [dragging],
  );

  const endDrag = useCallback(() => setDragging(false), []);

  /**
   * Keyboard gets the same control (proto:4366-4369). A separator you can only
   * drag is a control half the people cannot use — and `role="separator"` with
   * `aria-valuenow` is what makes it one to a screen reader rather than a
   * decorative strip.
   */
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const step = e.shiftKey ? 32 : 8;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setSidebarWidth(width - step);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        setSidebarWidth(width + step);
      } else if (e.key === 'Home') {
        e.preventDefault();
        setSidebarWidth(SIDEBAR_DEFAULT_WIDTH);
      }
    },
    [width],
  );

  /**
   * Collapsing UNMOUNTS the separator, so a drag in flight never gets its
   * `pointerup`. Left alone the drag stays "live" for good: `dragging` never
   * returns to false, the effect below never runs its cleanup, and the whole
   * document keeps the resize cursor and the selection lock.
   *
   * Adjusted DURING RENDER rather than from an effect, which is what React
   * prescribes for resetting state that an incoming value has invalidated.
   * React re-runs the component before committing, so the lock is released in
   * the same paint the sidebar collapses in; from an effect the state would
   * change AFTER the commit — a second render pass with the cursor still stuck
   * for its duration, which is the cascade `set-state-in-effect` names.
   */
  const [wasCollapsed, setWasCollapsed] = useState(collapsed);
  if (wasCollapsed !== collapsed) {
    setWasCollapsed(collapsed);
    if (collapsed) setDragging(false);
  }

  // While dragging, the whole page shows the resize cursor and stops selecting
  // text — otherwise sweeping across the document highlights it, and the
  // cursor flickers to a text caret every time it crosses a label.
  //
  // The cleanup is "this drag ended" by EVERY route there is — pointerup, a
  // collapse, an unmount mid-drag — so the width commit belongs in it rather
  // than in `endDrag`, which only ever covered the first of the three.
  useEffect(() => {
    if (!dragging) return;
    const { style } = document.body;
    const prevCursor = style.cursor;
    const prevSelect = style.userSelect;
    style.cursor = 'col-resize';
    style.userSelect = 'none';
    return () => {
      style.cursor = prevCursor;
      style.userSelect = prevSelect;
      commitSidebarWidth();
    };
  }, [dragging]);

  return (
    <>
      {drawerOpen && (
        <div
          data-sidebar-backdrop
          aria-hidden="true"
          className="fixed inset-0 z-40 bg-scrim"
          onClick={() => {
            if (isTopModalLayer()) setSidebarCollapsed(true);
          }}
        />
      )}
      <aside
        ref={asideRef}
        id={SIDEBAR_DOM_ID}
        aria-label={label}
        role={drawerOpen ? 'dialog' : undefined}
        aria-modal={drawerOpen ? true : undefined}
        tabIndex={drawerOpen ? -1 : undefined}
        inert={collapsed}
        className={cn(
          'h-full shrink-0 overflow-hidden border-r bg-sidebar',
          narrow ? 'fixed inset-y-0 left-0 z-50 shadow-2xl' : 'relative',
          collapsed ? 'border-r-transparent' : 'border-line',
          // An easing curve would lag the cursor, so the transition is off for
          // the duration of the drag (proto:89) — and off again for a change
          // nobody gestured at (`instant`), where a 240ms slide would be the
          // nav appearing to move on its own.
          dragging || instant
            ? 'transition-none'
            : 'transition-[width] duration-[240ms] ease-[cubic-bezier(.2,.8,.2,1)]',
        )}
        style={{
          width: collapsed ? 0 : narrow ? SIDEBAR_DRAWER_WIDTH : width,
          maxWidth: narrow ? SIDEBAR_DRAWER_MAX_WIDTH : undefined,
        }}
      >
        {/* proto:104 — `padding:16px 14px 18px`, and an explicit width so the
            column does not reflow while the frame animates to zero. */}
        <div
          className="flex h-full flex-col px-3.5 pt-4 pb-[18px]"
          style={{
            width: narrow ? SIDEBAR_DRAWER_WIDTH : width,
            maxWidth: narrow ? SIDEBAR_DRAWER_MAX_WIDTH : undefined,
          }}
        >
          {header}
          {children}
        </div>
      </aside>

      {/* The handle straddles the border without occupying layout: its own
          width is cancelled by the negative margins, so nothing shifts when
          the sidebar collapses and it goes away (proto:92-97). */}
      {!narrow && !collapsed && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={`Resize ${label}`}
          aria-valuenow={width}
          aria-valuemin={SIDEBAR_MIN_WIDTH}
          aria-valuemax={SIDEBAR_MAX_WIDTH}
          tabIndex={0}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onKeyDown={onKeyDown}
          onDoubleClick={() => setSidebarWidth(SIDEBAR_DEFAULT_WIDTH)}
          className="group/grip relative z-30 -mx-[3.5px] w-[7px] flex-none cursor-col-resize"
        >
          <span
            aria-hidden
            className={cn(
              'absolute inset-y-0 left-[3px] w-px transition-colors',
              dragging ? 'bg-accent' : 'bg-transparent group-hover/grip:bg-accent',
              'group-focus-visible/grip:bg-accent',
            )}
          />
        </div>
      )}
    </>
  );
}
