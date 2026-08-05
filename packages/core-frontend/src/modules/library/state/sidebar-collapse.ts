import { useSyncExternalStore } from 'react';

/**
 * Whether the Library's group nav is hidden — shared between the two places
 * that care: the top-bar toggle (in the toolbar module) and `LibraryLayout`
 * (which renders the sidebar). A module store rather than a context because
 * those two consumers meet only at the app root, and the shell should not
 * have to know a feature module's UI state to compose the toolbar.
 *
 * Session-scoped on purpose, exactly like the `useState` it replaces: hiding
 * the nav is a "give me the page for a minute" gesture, not a setting, so a
 * reload brings it back. Persisting it would strand a user who collapsed it
 * once on a navless Library with a button they have to rediscover.
 */

let collapsed = false;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function toggleLibrarySidebar(): void {
  collapsed = !collapsed;
  listeners.forEach((l) => l());
}

/** Direct set — used by tests to reset the module state between cases. */
export function setLibrarySidebarCollapsed(value: boolean): void {
  if (value === collapsed) return;
  collapsed = value;
  listeners.forEach((l) => l());
}

export function useLibrarySidebar(): { collapsed: boolean; toggle: () => void } {
  const current = useSyncExternalStore(subscribe, () => collapsed);
  return { collapsed: current, toggle: toggleLibrarySidebar };
}
