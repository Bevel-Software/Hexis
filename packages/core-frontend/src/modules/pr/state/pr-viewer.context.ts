import { createContext, useContext } from 'react';
import type { PullRequestDetail } from '@bevel-software/shared';

export interface PrViewerContextValue {
  /** Currently-open PR number, or null when the viewer is closed. */
  openPrNumber: number | null;
  /** Fetched detail for the open PR. Null while loading / when viewer closed. */
  detail: PullRequestDetail | null;
  /** Currently-selected file path in the viewer (`files[].path`). Null = first file. */
  selectedPath: string | null;
  isLoading: boolean;
  lastError: string | null;
  /**
   * True when the open CR failed to load specifically because it no longer
   * exists (backend 404) — as opposed to a transient/network error. Lets the
   * viewer show a calm "no longer available" state instead of an alarming error
   * banner. This is the common outcome of a routine deep-linking a CR whose row
   * is gone (see `RoutineRunDetailsDialog` → `openPr`).
   */
  notFound: boolean;
  openPr(prNumber: number): void;
  closeViewer(): void;
  selectPath(path: string | null): void;
  /** Force-refresh the detail for the currently-open PR (bypasses backend cache). */
  refresh(): Promise<void>;
}

export const PrViewerContext = createContext<PrViewerContextValue | null>(null);

export function usePrViewer(): PrViewerContextValue {
  const ctx = useContext(PrViewerContext);
  if (!ctx) throw new Error('usePrViewer must be used within PrViewerContext.Provider');
  return ctx;
}
