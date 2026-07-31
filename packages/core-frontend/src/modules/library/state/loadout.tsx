import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

/**
 * The loadout — the skills and integrations this user has explicitly
 * activated (Hearthstone-deck-tracker sidebar in the approved mock).
 *
 * DELIBERATE STUB: there is no backend for per-user skill activation yet, so
 * the loadout lives client-side in localStorage under
 * `bevel-library-loadout-v1`. It survives reloads on this browser but does not
 * roam across devices and nothing server-side consumes it yet. When a backend
 * feature lands (e.g. the MCP session registering only loadout tools), this
 * provider is the single place to swap the persistence.
 */

export const LOADOUT_STORAGE_KEY = 'bevel-library-loadout-v1';

export type LoadoutKind = 'skill' | 'integration';

interface LoadoutState {
  skills: string[];
  integrations: string[];
}

export interface LoadoutContextValue {
  skills: string[];
  integrations: string[];
  total: number;
  isIn(kind: LoadoutKind, id: string): boolean;
  /** Toggle membership; returns true when the item was ADDED. */
  toggle(kind: LoadoutKind, id: string): boolean;
  remove(kind: LoadoutKind, id: string): void;
}

const LoadoutContext = createContext<LoadoutContextValue | null>(null);

function load(): LoadoutState {
  try {
    const raw = localStorage.getItem(LOADOUT_STORAGE_KEY);
    if (!raw) return { skills: [], integrations: [] };
    const parsed = JSON.parse(raw) as Partial<LoadoutState>;
    return {
      skills: Array.isArray(parsed.skills) ? parsed.skills.filter((s) => typeof s === 'string') : [],
      integrations: Array.isArray(parsed.integrations)
        ? parsed.integrations.filter((s) => typeof s === 'string')
        : [],
    };
  } catch {
    return { skills: [], integrations: [] };
  }
}

function persist(state: LoadoutState): void {
  try {
    localStorage.setItem(LOADOUT_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage full/unavailable — the in-memory loadout still works this session.
  }
}

export function LoadoutProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<LoadoutState>(load);
  // Ref mirror so two mutations in one React batch (e.g. add skill + add
  // integration from the same event) compose instead of clobbering each other.
  const current = useRef(state);

  const update = useCallback((next: LoadoutState) => {
    current.current = next;
    persist(next);
    setState(next);
  }, []);

  const isIn = useCallback(
    (kind: LoadoutKind, id: string) =>
      (kind === 'skill' ? state.skills : state.integrations).includes(id),
    [state],
  );

  const toggle = useCallback(
    (kind: LoadoutKind, id: string): boolean => {
      const prev = current.current;
      const key = kind === 'skill' ? 'skills' : 'integrations';
      const list = prev[key];
      const added = !list.includes(id);
      update({
        ...prev,
        [key]: added ? [...list, id] : list.filter((x) => x !== id),
      });
      return added;
    },
    [update],
  );

  const remove = useCallback(
    (kind: LoadoutKind, id: string) => {
      const prev = current.current;
      const key = kind === 'skill' ? 'skills' : 'integrations';
      update({ ...prev, [key]: prev[key].filter((x) => x !== id) });
    },
    [update],
  );

  const value = useMemo<LoadoutContextValue>(
    () => ({
      skills: state.skills,
      integrations: state.integrations,
      total: state.skills.length + state.integrations.length,
      isIn,
      toggle,
      remove,
    }),
    [state, isIn, toggle, remove],
  );

  return <LoadoutContext.Provider value={value}>{children}</LoadoutContext.Provider>;
}

export function useLoadout(): LoadoutContextValue {
  const ctx = useContext(LoadoutContext);
  if (!ctx) throw new Error('useLoadout must be used within LoadoutProvider');
  return ctx;
}
