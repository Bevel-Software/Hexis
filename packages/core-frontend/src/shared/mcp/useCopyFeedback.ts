import { useCallback, useEffect, useState } from 'react';

/**
 * "Copied" affordance with a 1500ms auto-reset. Owns the timer + its teardown
 * (so an unmounting page can't fire a stale setState), shared by the reveal
 * modal and every CopyBlock. `copy(text)` writes to the clipboard and flags
 * copied; a rejected write (insecure context / denied permission) leaves the
 * textarea selectable for manual copy and shows no false "Copied".
 *
 * Its own file rather than sitting beside `CopyBlock`: a module that exports
 * both a component and a plain function breaks React Fast Refresh, which
 * lints as `react-refresh/only-export-components`.
 */
export function useCopyFeedback(): { copied: boolean; copy: (text: string) => void } {
  // A counter, not a boolean: `setState(true)` on an already-true boolean
  // bails out of the render, so a second copy inside the 1500ms window would
  // never restart the timer and its checkmark would vanish almost at once.
  // Each success bumps the counter, which re-arms the effect below.
  const [copyCount, setCopyCount] = useState(0);
  useEffect(() => {
    if (copyCount === 0) return;
    const timerId = window.setTimeout(() => setCopyCount(0), 1500);
    return () => window.clearTimeout(timerId);
  }, [copyCount]);
  const copy = useCallback((text: string) => {
    /**
     * `navigator.clipboard` is absent in an insecure context — which this app
     * routinely runs in, since the default deployment is plain http on
     * localhost. Reaching for `.writeText` there throws a TypeError
     * SYNCHRONOUSLY, before any promise exists, so `void` swallows nothing and
     * the click errors instead of failing quietly.
     */
    if (!navigator.clipboard?.writeText) {
      setCopyCount(0);
      return;
    }
    void navigator.clipboard
      .writeText(text)
      .then(() => setCopyCount((n) => n + 1))
      // Clear rather than ignore: a failure inside the 1500ms window of an
      // earlier success would otherwise leave the checkmark up, reporting that
      // this copy worked when it did not.
      .catch(() => setCopyCount(0));
  }, []);
  return { copied: copyCount > 0, copy };
}
