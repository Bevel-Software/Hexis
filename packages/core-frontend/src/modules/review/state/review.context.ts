import { createContext, useContext } from 'react';
import type { FileDiffPayload, ReviewSession } from '@bevel-software/platform-shared';

export interface ReviewContextValue {
  session: ReviewSession | null;
  /** Currently selected path in the review panel — the one whose diff is showing. */
  selectedPath: string | null;
  fileDiff: FileDiffPayload | null;
  isLoadingDiff: boolean;
  lastError: string | null;
  /** True while the session is still being restored on mount / refreshed. */
  isLoading: boolean;
  refresh(): Promise<void>;
  selectPath(path: string | null): Promise<void>;
  acceptOne(path: string): Promise<void>;
  rejectOne(path: string): Promise<void>;
  acceptAll(): Promise<void>;
  rejectAll(): Promise<void>;
  /** Dismiss `lastError` (e.g. the user closing the error banner). */
  clearError(): void;
}

export const ReviewContext = createContext<ReviewContextValue | null>(null);

export function useReview(): ReviewContextValue {
  const ctx = useContext(ReviewContext);
  if (!ctx) throw new Error('useReview must be used within ReviewContext.Provider');
  return ctx;
}
