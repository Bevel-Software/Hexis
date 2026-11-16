import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { copyToClipboard } from '../../lib/clipboard';
import { Button } from '../components';
import { SnippetBlock } from './SnippetBlock';

/**
 * "Copy prompt": one button that puts a ready-made prompt on the clipboard,
 * for the reader to paste into their agent. The agent then does the setup
 * itself, so the reader never has to find a settings file or read a
 * configuration. The prompt is not shown: what matters is the one action.
 */
export function CopyPromptButton({
  value,
  label = 'Copy prompt',
  onCopyFailed,
  className,
}: {
  /** The prompt to copy. */
  value: string;
  label?: string;
  onCopyFailed?: () => void;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  // A browser may refuse the clipboard (plain http, a blocked permission).
  // Then the prompt is shown, so it can be selected and copied by hand.
  const [refused, setRefused] = useState(false);
  const resetTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(resetTimer.current), []);

  async function copy() {
    const ok = await copyToClipboard(value);
    if (!ok) onCopyFailed?.();
    setRefused(!ok);
    window.clearTimeout(resetTimer.current);
    // Back to idle FIRST, so a repeat copy is a real state change and the live
    // region announces it again (as SnippetBlock does).
    setCopied(false);
    window.setTimeout(() => setCopied(ok), 0);
    resetTimer.current = window.setTimeout(() => setCopied(false), 1500);
  }

  return (
    <>
      <Button variant="primary" size="sm" onClick={() => void copy()} className={className}>
        {copied ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
        {copied ? 'Copied' : label}
      </Button>
      <span role="status" className="sr-only">
        {copied ? 'Copied' : ''}
      </span>
      {refused && (
        <div className="mt-3 space-y-2 text-detail text-danger" role="alert">
          <p>Your browser did not allow copying. Select the prompt and copy it:</p>
          <SnippetBlock value={value} copyLabel="Copy prompt" wrap />
        </div>
      )}
    </>
  );
}
