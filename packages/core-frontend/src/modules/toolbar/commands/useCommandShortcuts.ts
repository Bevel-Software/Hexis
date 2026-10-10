import { useEffect } from 'react';
import { useLatestRef } from '../../../shared/components';
import { shortcutId, type CommandAction, type CommandContext } from './actions';

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
 * Bind every offered command's `shortcut` on the document: `C` for Create
 * new page, ⇧I for Invite people, ⇧K for Knowledge, ⇧S for Skills & Tools,
 * and whatever letter a distribution gave its own commands
 * (`mergeCommandActions` has already dropped the ones that are not one
 * letter or are taken). The key a row shows is the key bound, one field.
 * Mounted once, by the toolbar's palette.
 *
 * A letter is a lot to claim, so it is claimed only when nobody could mean it
 * as text or as anything else:
 *
 *  - focus is not in a field or an editor (a `c` typed into a page is a `c`);
 *  - no Ctrl, ⌘ or Alt is held (Ctrl+C is copy);
 *  - Shift is held exactly when the shortcut has it: `C` runs without it,
 *    ⇧K with it, and ⇧C runs nothing;
 *  - no modal dialog is up (it owns the keyboard, as it does for Ctrl/⌘K);
 *  - the palette is shut (`enabled`) — open, every key is the query's.
 *
 * Only commands on offer run: ⇧I for someone who may not invite does
 * nothing, and lets the key through.
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
    function onKeyDown(e: KeyboardEvent) {
      if (!latest.current.enabled || e.defaultPrevented || e.repeat) return;
      if (e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      // The pressed key as a shortcut's id (`c`, `shift+k`), matched against
      // the commands on offer now — read per key press, since what is
      // offered follows the page on screen.
      const pressed = shortcutId({ key: e.key, shift: e.shiftKey });
      const action = latest.current.actions.find((a) => shortcutId(a.shortcut) === pressed);
      if (!action) return;
      e.preventDefault();
      latest.current.run(action, latest.current.ctx);
    }

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [latest]);
}
