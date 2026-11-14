/**
 * The handle under an HTML page's frame where the host grows with the
 * content: the reader drags it to make the frame taller or shorter, or
 * nudges it from the keyboard.
 *
 * Plain DOM, no React and no module scope: the browser suite loads this
 * function's own source into a page and drives it with a real pointer, over
 * a real sandboxed frame — the one thing a stand-in document cannot answer
 * is whether a drag that crosses the frame keeps reaching the handle, which
 * is what pointer capture is for. Anything this closes over that is not an
 * argument would not travel with it.
 */

/** The standard height of the frame where the host grows with the content. */
export const HTML_FRAME_STANDARD_HEIGHT = 480;
/** The least a reader can make it: enough to see that there is a page. */
export const HTML_FRAME_MIN_HEIGHT = 160;
/** The most: a tall dashboard's worth; past it the page scrolls inside. */
export const HTML_FRAME_MAX_HEIGHT = 2400;
/** One keyboard nudge, in CSS pixels. */
export const HTML_FRAME_KEY_STEP = 24;

export interface FrameResizeHandleOptions {
  /** The frame's current height, read when a drag or a nudge starts. */
  current: () => number;
  /** Apply a height while it changes; called on every move. */
  apply: (height: number) => void;
  /** A height the reader settled on: the drag ended, or a key was pressed. */
  settle: (height: number) => void;
  /** The least height to apply. */
  min: number;
  /** The most. */
  max: number;
  /** One keyboard nudge. */
  step: number;
}

/**
 * Attach the drag and the keys to `handle`; returns what detaches them.
 * `data-dragging` on the handle says a drag is under way, for the frame to
 * stop taking the pointer meanwhile. The handle is also told to take no
 * touch gesture of the browser's (`touch-action: none`) while attached: a
 * finger dragging it would otherwise read as scrolling the page, and the
 * browser would cancel the pointer before the resize was done.
 */
export function attachFrameResizeHandle(handle: HTMLElement, options: FrameResizeHandleOptions): () => void {
  let start: { y: number; height: number; pointerId: number } | null = null;

  const clamp = (height: number) => Math.min(options.max, Math.max(options.min, Math.round(height)));
  const ownTouchAction = handle.style.touchAction;
  handle.style.touchAction = 'none';

  const onPointerDown = (event: PointerEvent) => {
    // One drag at a time, by the main button: a second finger or a second
    // button mid-drag must not take the drag over, or the first pointer's
    // moves would be ignored and the wrong one would end it.
    if (start || event.button !== 0) return;
    start = { y: event.clientY, height: options.current(), pointerId: event.pointerId };
    handle.setAttribute('data-dragging', 'true');
    // Capture: the pointer will cross the frame below, which would otherwise
    // take every event from then on — a frame is its own document.
    if (typeof handle.setPointerCapture === 'function') handle.setPointerCapture(event.pointerId);
    event.preventDefault();
  };
  const onPointerMove = (event: PointerEvent) => {
    if (!start || event.pointerId !== start.pointerId) return;
    options.apply(clamp(start.height + (event.clientY - start.y)));
  };
  /** Let the pointer go and clear the drag's marks; the drag's height is the caller's to settle. */
  const letGo = (pointerId: number) => {
    start = null;
    handle.removeAttribute('data-dragging');
    if (typeof handle.releasePointerCapture === 'function') {
      try {
        handle.releasePointerCapture(pointerId);
      } catch {
        // Already released with the pointer; nothing to let go of.
      }
    }
  };
  const end = (event: PointerEvent) => {
    if (!start || event.pointerId !== start.pointerId) return;
    const height = clamp(start.height + (event.clientY - start.y));
    letGo(event.pointerId);
    options.settle(height);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const direction = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
    if (direction === 0) return;
    event.preventDefault();
    options.settle(clamp(options.current() + direction * options.step));
  };

  handle.addEventListener('pointerdown', onPointerDown);
  handle.addEventListener('pointermove', onPointerMove);
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
  handle.addEventListener('keydown', onKeyDown);
  return () => {
    // Detached mid-drag (the preview was rebuilt under the reader's finger):
    // the drag ends where it is, settled at the height it had reached, so
    // the caller's dragging state and the frame's pointer-events are not
    // left as they were in the middle of it.
    if (start) {
      const height = clamp(options.current());
      letGo(start.pointerId);
      options.settle(height);
    }
    handle.style.touchAction = ownTouchAction;
    handle.removeEventListener('pointerdown', onPointerDown);
    handle.removeEventListener('pointermove', onPointerMove);
    handle.removeEventListener('pointerup', end);
    handle.removeEventListener('pointercancel', end);
    handle.removeEventListener('keydown', onKeyDown);
  };
}
