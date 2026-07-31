import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const TRANSITION_MS = 220;
// Pull-down distance (in px) beyond which release dismisses the sheet. Below
// this the sheet snaps back to its open position. Tuned for thumb gestures on
// a phone — small enough that a deliberate pull dismisses, large enough that
// an accidental nudge doesn't.
const SWIPE_CLOSE_THRESHOLD_PX = 100;

interface SlideOverlayProps {
  open: boolean;
  onClose: () => void;
  side: 'left' | 'right' | 'bottom';
  /** Tailwind classes for the panel itself. Caller controls width/height/rounding. */
  panelClassName?: string;
  /** Optional label for the dialog (read by screen readers). */
  ariaLabel?: string;
  /**
   * Enables swipe-down-to-close on bottom sheets. The gesture only initiates
   * on descendants marked `data-swipe-handle="true"` so scrollable content
   * inside the panel is unaffected.
   */
  swipeToClose?: boolean;
  children: ReactNode;
}

export function SlideOverlay({
  open,
  onClose,
  side,
  panelClassName,
  ariaLabel,
  swipeToClose,
  children,
}: SlideOverlayProps) {
  // `mounted` lags behind `open` on close so the exit transition has time to play
  // before the panel unmounts. `visible` toggles the open-state class one frame
  // after mount so the browser registers the transition's starting state.
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(false);
  // Pixel offset from the resting (open) position while a swipe is in progress
  // or animating out. 0 means "at the open position"; a positive value (bottom
  // sheet only, for now) means "pulled down by that many px".
  const [dragOffset, setDragOffset] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const dragPointerId = useRef<number | null>(null);
  const dragStartY = useRef(0);
  // Track both rAF handles so the cleanup can cancel the inner frame too — the
  // earlier version only cancelled r1, which left r2 free to fire and flip
  // `visible` back to true after a fast close had already flipped it to false.
  const r1Ref = useRef<number | null>(null);
  const r2Ref = useRef<number | null>(null);
  // The swipe-close gesture schedules onClose() after TRANSITION_MS so the
  // exit animation can play out. Track that handle so a reopen (or a second
  // gesture) can cancel a still-pending timer before it fires onClose on the
  // wrong instance of the sheet.
  const closeTimeoutRef = useRef<number | null>(null);

  const clearCloseTimeout = useCallback(() => {
    if (closeTimeoutRef.current !== null) {
      window.clearTimeout(closeTimeoutRef.current);
      closeTimeoutRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (open) {
      // Reopening cancels any in-flight close-after-swipe timer so it can't
      // fire onClose against the now-open sheet.
      clearCloseTimeout();
      setMounted(true);
      setDragOffset(0);
      // Two requestAnimationFrame ticks: the first ensures the element is in the
      // DOM with its initial transform; the second flips `visible` so the browser
      // sees a transition between the two states. A single rAF is enough most of
      // the time but flakes in Safari/Firefox under load.
      r1Ref.current = requestAnimationFrame(() => {
        r1Ref.current = null;
        r2Ref.current = requestAnimationFrame(() => {
          r2Ref.current = null;
          setVisible(true);
        });
      });
      return () => {
        if (r1Ref.current !== null) cancelAnimationFrame(r1Ref.current);
        if (r2Ref.current !== null) cancelAnimationFrame(r2Ref.current);
        r1Ref.current = null;
        r2Ref.current = null;
      };
    }
    setVisible(false);
    const t = window.setTimeout(() => {
      setMounted(false);
      setDragOffset(0);
    }, TRANSITION_MS);
    return () => window.clearTimeout(t);
  }, [open, clearCloseTimeout]);

  useEffect(() => clearCloseTimeout, [clearCloseTimeout]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  const allowSwipe = swipeToClose && side === 'bottom';

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (!allowSwipe) return;
    const target = e.target as Element | null;
    // Only initiate the drag if the gesture started on (or inside) an element
    // the caller explicitly designated as a drag handle. That keeps the close
    // button and any scrollable content from accidentally triggering a swipe.
    if (!target?.closest('[data-swipe-handle="true"]')) return;
    dragPointerId.current = e.pointerId;
    dragStartY.current = e.clientY;
    setIsDragging(true);
  }, [allowSwipe]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (dragPointerId.current !== e.pointerId) return;
    const dy = Math.max(0, e.clientY - dragStartY.current);
    // Capture once the user has clearly committed to a vertical drag. Doing
    // this lazily lets a quick tap on the handle still register as a click on
    // descendants if they happen to listen for one.
    if (dy > 4 && !e.currentTarget.hasPointerCapture(e.pointerId)) {
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* element gone */ }
    }
    setDragOffset(dy);
  }, []);

  const handlePointerEnd = useCallback((e: React.PointerEvent) => {
    if (dragPointerId.current !== e.pointerId) return;
    dragPointerId.current = null;
    setIsDragging(false);
    if (dragOffset > SWIPE_CLOSE_THRESHOLD_PX) {
      // Continue the gesture into a close: drive the panel offscreen with the
      // standard CSS transition (now re-enabled since isDragging is false), and
      // call onClose after the animation completes so the parent's open=false
      // doesn't fight the in-flight transform interpolation.
      setDragOffset(window.innerHeight);
      clearCloseTimeout();
      closeTimeoutRef.current = window.setTimeout(() => {
        closeTimeoutRef.current = null;
        onClose();
      }, TRANSITION_MS);
    } else {
      // Below threshold → snap back to the resting position via the CSS
      // transition. Setting dragOffset = 0 triggers the interpolation.
      setDragOffset(0);
    }
  }, [dragOffset, onClose, clearCloseTimeout]);

  if (!mounted) return null;
  if (typeof document === 'undefined') return null;

  // Compute the panel transform inline so the swipe-drag offset and the
  // open/close animation share one source of truth. Class-based transforms
  // would force a hand-off between inline (during drag) and class (during
  // exit) that causes a visible snap when releasing-to-close.
  let transform: string;
  if (dragOffset > 0) {
    transform = side === 'bottom'
      ? `translate3d(0, ${dragOffset}px, 0)`
      : `translate3d(${-dragOffset}px, 0, 0)`;
  } else if (visible) {
    transform = 'translate3d(0, 0, 0)';
  } else if (side === 'bottom') {
    transform = 'translate3d(0, 100%, 0)';
  } else if (side === 'right') {
    transform = 'translate3d(100%, 0, 0)';
  } else {
    transform = 'translate3d(-100%, 0, 0)';
  }

  const panelPosition =
    side === 'left'
      ? 'top-0 bottom-0 left-0'
      : side === 'right'
        ? 'top-0 bottom-0 right-0'
        : 'left-0 right-0 bottom-0';

  return createPortal(
    <div
      className="fixed inset-0 z-50"
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
    >
      <div
        className="absolute inset-0 bg-scrim"
        // Tying backdrop opacity to drag progress makes the close gesture feel
        // continuous — the sheet and the backdrop both fade together as the
        // user pulls down. Falls back to a fixed CSS transition when nothing
        // is being dragged so the regular open/close still animates cleanly.
        style={{
          opacity: visible ? Math.max(0, 1 - dragOffset / 600) : 0,
          transition: isDragging ? 'none' : `opacity ${TRANSITION_MS}ms ease-out`,
        }}
        onClick={onClose}
      />
      <div
        className={`absolute ${panelPosition} bg-white shadow-2xl will-change-transform ${panelClassName ?? ''}`}
        style={{
          transform,
          transition: isDragging ? 'none' : `transform ${TRANSITION_MS}ms ease-out`,
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
