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
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timerId = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timerId);
  }, [copied]);
  const copy = useCallback((text: string) => {
    void navigator.clipboard
      .writeText(text)
      .then(() => setCopied(true))
      .catch(() => {});
  }, []);
  return { copied, copy };
}
