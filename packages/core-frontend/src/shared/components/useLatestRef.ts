import { useEffect, useRef, type RefObject } from 'react';

/**
 * Mirror a fresh-every-render value into a stable ref.
 *
 * The pattern this replaces was hand-rolled in three places (Dialog's
 * `onClose`/`busy`, AnchoredMenu's `onDismiss`, AdminRolesPage's `onCancel`)
 * and exists for one reason: callers pass a fresh arrow each render, and an
 * effect that lists it in its deps tears down and re-subscribes its document
 * listeners on every render of an open overlay. Reading the value through
 * this ref instead gives the effect a dependency-free view of the latest
 * callback, so it subscribes once for the life of the overlay.
 *
 * The write happens in a passive effect, after paint — the same timing every
 * hand-rolled copy used. Do not read the ref during render; it is for event
 * handlers and effects.
 */
export function useLatestRef<T>(value: T): RefObject<T> {
  const ref = useRef<T>(value);
  useEffect(() => {
    ref.current = value;
  }, [value]);
  return ref;
}
