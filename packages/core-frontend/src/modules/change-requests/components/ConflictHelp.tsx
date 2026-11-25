import { useEffect, useRef, useState } from 'react';
import { Button } from '../../../shared/components';

/**
 * "Ask your agent" — the way out of a conflicted change request.
 *
 * A conflict is the one refusal the buttons on these surfaces cannot fix:
 * somebody has to re-do the proposal against text that moved, and the user's
 * agent is the hand that does that here. So the surface hands over the EXACT
 * prompt, ready to paste — the request number and both branches filled in —
 * because "ask your agent to fix it" without the words is an errand, and an
 * errand is where this flow used to die.
 *
 * The prompt is written for the agent, not the person, so it stays closed:
 * one button copies it, and "Show prompt" opens it for whoever wants to read
 * it first. The copy MUST report failure: `navigator.clipboard` rejects
 * outright on a non-secure origin, and a silent no-op is the worst possible
 * answer to "copy this". A refused copy opens the prompt with its text
 * selected, so the keyboard's copy is the manual route.
 */
export function ConflictHelp({ prompt }: { prompt: string }) {
  const [copied, setCopied] = useState<null | 'ok' | 'fail'>(null);
  const [shown, setShown] = useState(false);
  const promptRef = useRef<HTMLPreElement>(null);

  async function copy() {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied('ok');
    } catch {
      setCopied('fail');
      setShown(true);
    }
    window.setTimeout(() => setCopied(null), 1800);
  }

  // Selected once it is on screen, which is the render after the refusal.
  useEffect(() => {
    if (copied === 'fail' && promptRef.current) {
      window.getSelection()?.selectAllChildren(promptRef.current);
    }
  }, [copied]);

  return (
    <div className="w-full">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => void copy()}>
          {copied === 'ok' ? 'Copied' : copied === 'fail' ? "Couldn't copy" : 'Copy prompt for your agent'}
        </Button>
        <Button variant="quiet" size="sm" aria-expanded={shown} onClick={() => setShown((s) => !s)}>
          {shown ? 'Hide prompt' : 'Show prompt'}
        </Button>
      </div>
      {shown && (
        <pre
          ref={promptRef}
          className="mt-1.5 select-text whitespace-pre-wrap break-words rounded-md border border-line bg-sunken p-2.5 font-mono text-meta leading-relaxed text-ink"
        >
          {prompt}
        </pre>
      )}
    </div>
  );
}
