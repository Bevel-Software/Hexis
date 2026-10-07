/**
 * The command menu's two public facts, for anything outside the toolbar that
 * talks about it or opens it — the Get set up list does both: which keys open
 * it on this platform, and a way to open it from a button.
 *
 * A plain module rather than a context: the palette lives in the toolbar and
 * the people asking for it (the setup column) sit beside it, not under it, so
 * a provider would have to wrap the whole shell to connect two leaves.
 */

/**
 * The shortcut belongs to ⌘ on Apple platforms and to Ctrl everywhere else —
 * and ONLY to that one. Ctrl+K on a Mac is the text fields' "delete to end of
 * line", which nobody pressing it there means as "search".
 */
const APPLE = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);

/** The keys as drawn: `⌘K` on Apple platforms, `Ctrl K` elsewhere. */
export const COMMAND_MENU_SHORTCUT_LABEL = APPLE ? '⌘K' : 'Ctrl K';

/** The keys as `aria-keyshortcuts` spells them. */
export const COMMAND_MENU_SHORTCUT_ARIA = APPLE ? 'Meta+K' : 'Control+K';

/** Whether a keydown is this platform's command-menu shortcut. */
export function isCommandMenuShortcut(e: KeyboardEvent): boolean {
  if (e.altKey || e.shiftKey || e.key.toLowerCase() !== 'k') return false;
  return APPLE ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}

const openRequests = new Set<() => void>();

/**
 * Open the command menu, as Ctrl/⌘K would. A no-op where no palette is
 * mounted (a test, a host without the toolbar).
 */
export function openCommandMenu(): void {
  openRequests.forEach((listener) => listener());
}

/** The palette's half of {@link openCommandMenu}; returns the unsubscribe. */
export function onCommandMenuRequest(listener: () => void): () => void {
  openRequests.add(listener);
  return () => openRequests.delete(listener);
}
