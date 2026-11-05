import { useCallback, useState } from 'react';

/**
 * "Try again" for a viewer that fetches its own bytes.
 *
 * Every byte-reading renderer here loads in an effect keyed on the workspace
 * and the path, and reports a failed read as a terminal message. That is
 * exactly as far as recovery went: a failure whose inputs are all unchanged
 * has nothing to re-trigger the effect, so a dropped connection or a 502 left
 * the pane on its error until something else remounted it. On the file page a
 * reload is at least available; in a pane that is part of a larger surface —
 * the change-request dialog, Version history's version pane — there was no way
 * back to the document at all.
 *
 * `attempt` goes in the read effect's dependency list and is the whole
 * mechanism; `retry()` bumps it. Automatic recovery on a path, workspace or
 * version change is untouched, since those change the deps by themselves.
 *
 * `ImageRenderer` grew this counter first, inline, for the change-request
 * pane. Shared here so the five other viewers answer a failed read the same
 * way rather than each inventing it.
 */
export function useReadRetry(): { attempt: number; retry: () => void } {
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { attempt, retry };
}
