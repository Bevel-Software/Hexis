import { useLayoutEffect, type RefObject } from 'react';

/**
 * Grow a textarea to fit its content, so the DOCUMENT COLUMN scrolls instead
 * of the textarea.
 *
 * The prose renderers used to be `h-full` boxes with a `flex-1` textarea
 * scrolling inside them. Once `KbDocumentShell` took over the scrolling, that
 * textarea would have collapsed to its two-row intrinsic height in an
 * auto-height column. Growing it keeps ONE scroller on the page: switching
 * between view and edit no longer moves the scrollbar, and the caret never
 * ends up in a second, nested scroll context.
 *
 * `scrollHeight` is 0 in a headless DOM, so the write is guarded — otherwise
 * the hook would pin every textarea to `height: 0px` under happy-dom.
 */
export function useAutoGrowTextarea(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
  enabled = true,
): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    // Reset first: without it the box can only ever grow, because
    // `scrollHeight` never reports less than the current height.
    el.style.height = 'auto';
    if (el.scrollHeight > 0) el.style.height = `${el.scrollHeight}px`;
  }, [ref, value, enabled]);
}
