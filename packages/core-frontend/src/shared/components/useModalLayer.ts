import { useCallback, useEffect, useRef } from 'react';

// LIFO stack of open modal layers (a <Dialog> + any hand-rolled modal that
// opts in via useModalLayer). Escape-to-close should only ever dismiss the
// TOPMOST layer — without this, a nested modal and its parent both listen on
// `document` and one Escape closes both. Each open layer registers a token;
// `isTopModalLayer(token)` tells a keydown handler whether it owns this Escape.
const modalLayerStack: symbol[] = [];

/**
 * Register this component as a modal layer while `active` is true, and return
 * a checker for whether it is currently the topmost layer. Hand-rolled modals
 * (that don't use <Dialog>) call this and guard their Escape/backdrop close on
 * `isTop()` so nesting them under a <Dialog> doesn't close both at once.
 *
 * The returned checker is a stable reference (memoized with `useCallback`), so
 * callers can list it in a `useEffect` dependency array without re-subscribing
 * every render.
 */
export function useModalLayer(active: boolean): () => boolean {
  const tokenRef = useRef<symbol>(Symbol('modal-layer'));
  useEffect(() => {
    if (!active) return;
    const token = tokenRef.current;
    modalLayerStack.push(token);
    return () => {
      const i = modalLayerStack.lastIndexOf(token);
      if (i !== -1) modalLayerStack.splice(i, 1);
    };
  }, [active]);
  return useCallback(
    () => modalLayerStack[modalLayerStack.length - 1] === tokenRef.current,
    [],
  );
}
