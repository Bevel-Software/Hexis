import { useEffect } from 'react';
import { useLatestRef } from '../../../shared/components';
import { shortcutSequence, type CommandAction, type CommandContext } from './actions';

/** How long the second key of a sequence (G, then K) is waited for. */
export const SEQUENCE_TIMEOUT_MS = 1000;

/**
 * Where a key is somebody typing, not a command: a text field, a select, an
 * editor (CodeMirror and the rich editors are `contenteditable`).
 */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  return (
    target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]') !==
    null
  );
}

/**
 * Bind every offered command's `shortcut` on the document: `C` for New
 * page, `G` then `K` for Knowledge, `G` then `S` for Skills & Tools, and
 * whatever keys a distribution gave its own commands (`mergeCommandActions`
 * has already dropped the ones that would collide). The keys a row shows
 * are the keys bound, one field. Mounted once, by the toolbar's palette.
 *
 * A bare letter is a lot to claim, so it is claimed only when nobody could
 * mean it as text or as anything else:
 *
 *  - focus is not in a field or an editor (a `c` typed into a page is a `c`);
 *  - no modifier is held (Ctrl+C is copy, Shift+C a capital);
 *  - no modal dialog is up (it owns the keyboard, as it does for Ctrl/⌘K);
 *  - the palette is shut (`enabled`) — open, every key is the query's.
 *
 * Only commands on offer run: `G` `K` with no Knowledge app does nothing,
 * and lets the key through. A sequence's first key waits
 * {@link SEQUENCE_TIMEOUT_MS} for its second, then is forgotten.
 */
export function useCommandShortcuts({
  actions,
  ctx,
  enabled,
  run,
}: {
  /** The commands on offer now (`useCommandActions`). */
  actions: readonly CommandAction[];
  ctx: CommandContext;
  enabled: boolean;
  /** How a command is run — the palette's own runner, so a failure is reported the same way. */
  run: (action: CommandAction, ctx: CommandContext) => void;
}): void {
  const latest = useLatestRef({ actions, ctx, enabled, run });

  useEffect(() => {
    let first: string | null = null;
    let timer: number | undefined;
    const forget = () => {
      first = null;
      window.clearTimeout(timer);
    };

    // The commands on offer now, by their keys; read per key press, since
    // what is offered follows the page on screen.
    const bound = (seq: string): CommandAction | undefined =>
      latest.current.actions.find((a) => shortcutSequence(a) === seq);

    const runBound = (keys: readonly string[]): boolean => {
      const action = bound(keys.join(' '));
      if (!action) return false;
      run(action, latest.current.ctx);
      return true;
    };
    const run = (action: CommandAction, ctx: CommandContext) => latest.current.run(action, ctx);

    function onKeyDown(e: KeyboardEvent) {
      if (!latest.current.enabled || e.defaultPrevented || e.repeat) return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || isTypingTarget(e.target)) {
        forget();
        return;
      }
      if (document.querySelector('[aria-modal="true"]')) {
        forget();
        return;
      }
      const key = e.key.toLowerCase();
      if (first !== null) {
        const sequence = [first, key];
        forget();
        if (runBound(sequence)) e.preventDefault();
        return;
      }
      if (runBound([key])) {
        e.preventDefault();
        return;
      }
      // The first key of a sequence: hold it for the second.
      const opensSequence = latest.current.actions.some((a) => {
        const keys = a.shortcut ?? [];
        return keys.length === 2 && keys[0]?.toLowerCase() === key;
      });
      if (opensSequence) {
        first = key;
        timer = window.setTimeout(forget, SEQUENCE_TIMEOUT_MS);
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      forget();
    };
  }, [latest]);
}
