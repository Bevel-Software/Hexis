import { useCallback, useEffect, useRef, useState } from 'react';
import { copyToClipboard } from '../../lib/clipboard';

/** What the last copy said: nothing yet (or it has faded), it landed, or the browser refused it. */
export type CopyStatus = 'idle' | 'copied' | 'failed';

/**
 * The one copy-feedback policy every copy button here follows: the
 * clipboard write, the "Copied" that fades after 1500ms, the refusal that
 * stays said until the next try, and a repeat copy that is announced again.
 * `CopyBlock`, `SnippetBlock` and the onboarding module's "Copy prompt"
 * button are presentations of THIS; none keeps a timer or a status of its own.
 *
 * - `copy(text)` resolves to the status that copy left: `copied`, `failed`
 *   (so a caller can add its own answer to a refusal: select the text, show
 *   it, raise a toast), or `idle` when a later copy started before this one's
 *   clipboard answer came back.
 * - Only the latest copy speaks. An earlier copy's answer that arrives after
 *   a later copy started is dropped: it neither changes the status nor starts
 *   the fade, so a slow refusal can never overwrite a later "Copied".
 * - A refusal (insecure context, denied permission, no clipboard at all) is
 *   `failed`, never a false "Copied": `copyToClipboard` answers false for all
 *   of them and never throws.
 * - Each copy first goes back to `idle`, before the clipboard answers, so a
 *   second copy is a real state change: a live region reading the status says
 *   "Copied" again instead of staying silent, and the 1500ms window restarts
 *   from the second copy rather than ending at the first one's deadline.
 *
 * Its own file rather than sitting beside `CopyBlock`: a module that exports
 * both a component and a plain function breaks React Fast Refresh, which
 * lints as `react-refresh/only-export-components`.
 */
export function useCopyFeedback(): {
  status: CopyStatus;
  copied: boolean;
  copy: (text: string) => Promise<CopyStatus>;
} {
  const [status, setStatus] = useState<CopyStatus>('idle');
  // One timer, cleared before it is replaced and when the page unmounts.
  const resetTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(resetTimer.current), []);
  // Which copy is the latest; an answer from any other is dropped.
  const latest = useRef(0);

  const copy = useCallback(async (text: string): Promise<CopyStatus> => {
    const request = ++latest.current;
    window.clearTimeout(resetTimer.current);
    setStatus('idle');
    const ok = await copyToClipboard(text);
    if (request !== latest.current) return 'idle';
    const next: CopyStatus = ok ? 'copied' : 'failed';
    setStatus(next);
    if (ok) resetTimer.current = window.setTimeout(() => setStatus('idle'), 1500);
    return next;
  }, []);

  return { status, copied: status === 'copied', copy };
}
