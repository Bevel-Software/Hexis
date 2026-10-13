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
  /** One keyboard nudge. */
  step: number;
}

/**
 * Attach the drag and the keys to `handle`; returns what detaches them.
 * `data-dragging` on the handle says a drag is under way, for the frame to
 * stop taking the pointer meanwhile.
 */
export function attachFrameResizeHandle(handle: HTMLElement, options: FrameResizeHandleOptions): () => void {
  let start: { y: number; height: number; pointerId: number } | null = null;

  const clamp = (height: number) => Math.max(options.min, Math.round(height));

  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
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
  const end = (event: PointerEvent) => {
    if (!start || event.pointerId !== start.pointerId) return;
    const height = clamp(start.height + (event.clientY - start.y));
    start = null;
    handle.removeAttribute('data-dragging');
    if (typeof handle.releasePointerCapture === 'function') {
      try {
        handle.releasePointerCapture(event.pointerId);
      } catch {
        // Already released with the pointer; nothing to let go of.
      }
    }
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
    handle.removeEventListener('pointerdown', onPointerDown);
    handle.removeEventListener('pointermove', onPointerMove);
    handle.removeEventListener('pointerup', end);
    handle.removeEventListener('pointercancel', end);
    handle.removeEventListener('keydown', onKeyDown);
  };
}
