import { useCallback, useEffect, useRef, type RefObject } from 'react';

/**
 * Hands keyboard focus across a swap that unmounts the control the user just
 * activated.
 *
 * Two views share one column: a document and its git log, say. The clock
 * that opens the log sits in the document's bar, and the bar unmounts with
 * the document; the pressed clock that closes it sits in the log's row, which
 * unmounts with the log. Either way the button a keyboard user just pressed
 * is gone from the DOM, focus falls to `document`, and the next Tab starts
 * from the top of the page.
 *
 * So the click handler names the state the swap lands in and where focus
 * should go once it has, BEFORE it changes that state:
 *
 *   const handoff = useFocusHandoff(view);
 *   <button onClick={() => { handoff('log', pressedClockRef); setView('log'); }} />
 *
 * When `state` becomes the named value, focus moves to the first named ref
 * that is on screen — name a fallback for a layout that does not render the
 * first. Only a swap the USER made hands focus off: a change that arrives
 * with no request behind it (a poll withdrawing the panel, a different file
 * opening) moves nothing, because nothing was named.
 *
 * Naming the destination state is what makes the request wait for the right
 * commit. A commit whose effects have not flushed yet when the user clicks
 * (a fetch rejecting a moment before) has them flushed BEFORE the click's
 * render; consumed there, the request would look for a control the swap has
 * not mounted yet and find nothing.
 */
export function useFocusHandoff<S>(
  state: S,
): (after: S, ...to: RefObject<HTMLElement | null>[]) => void {
  const pending = useRef<{ after: S; to: RefObject<HTMLElement | null>[] } | null>(null);
  useEffect(() => {
    const request = pending.current;
    if (!request || !Object.is(request.after, state)) return;
    pending.current = null;
    request.to.find((ref) => ref.current)?.current?.focus();
  }, [state]);
  return useCallback((after: S, ...to: RefObject<HTMLElement | null>[]) => {
    pending.current = { after, to };
  }, []);
}
