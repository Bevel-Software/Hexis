import { useSyncExternalStore } from 'react';

/**
 * The page on screen that an Edit click would open for editing right now, or
 * null: no page open, already editing (or entering it, or proposing), a file
 * with no editing surface, someone else holding the lock, or a reader who may
 * only propose.
 *
 * Edit mode is the viewer's own state, and should stay so — but the command
 * menu offers "Edit this page", and an entry that does nothing when chosen
 * is worse than none. So the viewer PUBLISHES its verdict here, the same
 * conditions its Edit button is drawn and enabled by, and the menu reads it.
 * One string rather than a context, because the menu lives in the toolbar,
 * above and beside the viewer, not under it.
 */
let editablePage: string | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Called by the viewer whenever its answer changes. */
export function publishEditablePage(path: string | null): void {
  if (editablePage === path) return;
  editablePage = path;
  listeners.forEach((l) => l());
}

/** Withdraw `path` — but only if it is still the published one (another viewer may have taken over). */
export function withdrawEditablePage(path: string): void {
  if (editablePage === path) publishEditablePage(null);
}

export function useEditablePage(): string | null {
  return useSyncExternalStore(
    subscribe,
    () => editablePage,
    () => null,
  );
}
