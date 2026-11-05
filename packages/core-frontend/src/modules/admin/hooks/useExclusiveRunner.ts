import { useCallback, useRef } from 'react';

/** Queues an async task behind every previously queued one. */
export type ExclusiveRunner = <T>(fn: () => Promise<T>) => Promise<T>;

/**
 * Page-level mutation queue. Roster mutations are snapshot-based server-side:
 * two overlapping writes each read the pre-mutation state, so the later commit
 * silently drops the earlier change — and their responses can land out of
 * order, letting a slow response overwrite a fresher roster. `run(fn)` starts
 * `fn` only after every previously queued task has settled, so requests (and
 * the rosters they return) apply in a strict order.
 */
export function useExclusiveRunner(): ExclusiveRunner {
  // Tail of the queue. The stored tail never rejects — a failed task must not
  // wedge every task queued after it — while callers still observe their own
  // task's rejection through the returned promise.
  const tail = useRef<Promise<unknown>>(Promise.resolve());
  return useCallback(<T,>(fn: () => Promise<T>): Promise<T> => {
    const next = tail.current.then(fn);
    tail.current = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }, []);
}
