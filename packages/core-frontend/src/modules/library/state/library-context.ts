import { createContext, useContext } from 'react';
import type { LibraryContextValue } from './library-data';

/**
 * The library's context object and its provider-optional hooks, in a file of
 * their own: `library-data.tsx` renders the provider COMPONENT, and fast
 * refresh only preserves state for files that export components alone — every
 * hook this module grows would otherwise cost the provider its hot reload.
 * (`useLibrary`, which predates the split, still lives beside the provider.)
 */
export const LibraryContext = createContext<LibraryContextValue | null>(null);

/**
 * The catalog's reload signal, tolerating an absent provider. For leaf
 * components (dialog panels) that only need to ANNOUNCE "the catalog
 * changed" — outside a provider (component tests, future embeddings) the
 * announcement has no audience, and that is fine.
 */
export function useLibraryReload(): () => void {
  const value = useContext(LibraryContext);
  return value?.reload ?? (() => {});
}
