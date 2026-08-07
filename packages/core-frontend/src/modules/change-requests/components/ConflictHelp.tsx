import { useState } from 'react';
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
 * The copy MUST report failure: `navigator.clipboard` rejects outright on a
 * non-secure origin, and a silent no-op is the worst possible answer to
 * "copy this". The prompt is also selectable text, so a refused clipboard
 * still leaves the manual route open.
 */
export function ConflictHelp({ prompt }: { prompt: string }) {
  const [copied, setCopied] = useState<null | 'ok' | 'fail'>(null);

  async function copy() {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied('ok');
    } catch {
      setCopied('fail');
    }
    window.setTimeout(() => setCopied(null), 1800);
  }

  return (
    <div className="w-full">
      <p className="text-meta text-ink-muted">
        Fastest fix: ask your agent to resolve it. Copy this prompt.
      </p>
      <div className="mt-1.5 flex items-start gap-2 rounded-md border border-line bg-sunken p-2.5">
        <pre className="min-w-0 flex-1 select-text whitespace-pre-wrap break-words font-mono text-meta leading-relaxed text-ink">
          {prompt}
        </pre>
        <Button variant="outline" size="tiny" className="shrink-0" onClick={() => void copy()}>
          {copied === 'ok' ? 'Copied' : copied === 'fail' ? "Couldn't copy" : 'Copy'}
        </Button>
      </div>
    </div>
  );
}
