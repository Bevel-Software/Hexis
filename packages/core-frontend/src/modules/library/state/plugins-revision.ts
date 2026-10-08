import { useSyncExternalStore } from 'react';

/**
 * How many plugins this tab has created — a signal for readers OUTSIDE the
 * Library's provider (the Get set up column sits beside both apps) that need
 * to hear "a plugin now exists" without asking `GET /api/plugins` on every
 * navigation. Bumped by `createPlugin` once the server has made it.
 */
let revision = 0;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const snapshot = () => revision;

/** A plugin was just created in this tab. */
export function notePluginCreated(): void {
  revision++;
  listeners.forEach((l) => l());
}

/** The current count, re-rendering the caller whenever it moves. */
export function usePluginsRevision(): number {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
