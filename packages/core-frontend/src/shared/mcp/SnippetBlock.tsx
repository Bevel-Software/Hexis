import { useEffect, useRef, useState } from 'react';
import { Check, Copy, X } from 'lucide-react';
import { cn } from '../../lib/utils';
import { copyToClipboard } from '../../lib/clipboard';
import { IconButton } from '../components';

/**
 * One snippet and the button that copies it: the copy rides the block it
 * copies. Its own component so one view can carry several (Other tools shows
 * the bare address AND the configuration), each with its own checkmark.
 *
 * Copying says so as a checkmark for anyone watching and as a live-region
 * announcement for anyone not. A failure is reported, never swallowed: the
 * icon turns into a cross, the live region says so, and `onCopyFailed` lets a
 * page with a toast name the alternative (select the text) as well.
 */
export function SnippetBlock({
  value,
  copyLabel,
  label,
  wrap = false,
  onCopyFailed,
  className,
}: {
  value: string;
  /** The button's accessible name: distinct per block when a view has several. */
  copyLabel: string;
  /** A line above the block, for a view that stacks several snippets. */
  label?: string;
  /** Show the whole value on several lines instead of scrolling it sideways: for the one command a dialog exists to hand over. */
  wrap?: boolean;
  onCopyFailed?: () => void;
  className?: string;
}) {
  const [copied, setCopied] = useState<'idle' | 'ok' | 'fail'>('idle');
  const textRef = useRef<HTMLDivElement>(null);

  // One timer, cleared before it is replaced: a second copy inside the 1.5s
  // window would otherwise inherit the FIRST copy's expiry and blank the
  // checkmark almost immediately.
  const resetTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(resetTimer.current), []);

  async function copy() {
    const ok = await copyToClipboard(value);
    if (!ok) onCopyFailed?.();
    window.clearTimeout(resetTimer.current);
    // Back to idle FIRST, so a repeat copy is a real state change and the
    // live region announces it again: setting 'ok' over 'ok' is a no-op that
    // says nothing to a screen reader.
    setCopied('idle');
    window.setTimeout(() => setCopied(ok ? 'ok' : 'fail'), 0);
    if (ok) {
      resetTimer.current = window.setTimeout(() => setCopied('idle'), 1500);
      return;
    }
    // A refused copy stays said until the next try, and the text is selected,
    // so the way round (the keyboard's own copy) is one key away. A cross that
    // flashed for a second and a half looked the same as nothing happening.
    const text = textRef.current;
    const selection = typeof window.getSelection === 'function' ? window.getSelection() : null;
    if (text && selection) selection.selectAllChildren(text);
  }

  return (
    <div className={className}>
      {label && <div className="mb-1.5 text-meta text-ink-muted">{label}</div>}
      {/* The text scrolls INSIDE the box, short of the copy button: a long
          command scrolled sideways must never run underneath the icon that
          copies it. */}
      <div className="relative">
        <div className="rounded-lg border border-line bg-sunken">
          <div
            ref={textRef}
            className={cn(
              'mr-10 overflow-x-auto py-2.5 pl-3',
              'font-mono text-detail text-ink',
              wrap ? 'whitespace-pre-wrap break-all' : value.includes('\n') ? 'whitespace-pre' : 'whitespace-nowrap',
            )}
          >
            {value}
          </div>
        </div>
        <IconButton
          size={24}
          aria-label={copyLabel}
          title={copyLabel}
          onClick={() => void copy()}
          className="absolute right-2 top-2"
        >
          {copied === 'ok' ? (
            <Check size={13} className="text-ok" />
          ) : copied === 'fail' ? (
            <X size={13} className="text-danger" />
          ) : (
            <Copy size={13} />
          )}
        </IconButton>
        {/* The icon's answer, said out loud for anyone not watching it. */}
        <span role="status" aria-live="polite" className="sr-only">
          {copied === 'ok' ? 'Copied' : copied === 'fail' ? 'Copy failed' : ''}
        </span>
      </div>
      {copied === 'fail' && (
        <p className="mt-1.5 text-meta text-danger">Your browser did not allow copying. The text is selected: press ⌘C or Ctrl+C.</p>
      )}
    </div>
  );
}
