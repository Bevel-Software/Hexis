import type { ReactNode } from 'react';
import { ReviewContext } from './review.context';
import { useReviewState } from '../hooks/useReviewState';
import { useWorkspace } from '../../workspace/state/workspace.context';
import { useGit } from '../../git/state/git.context';

/**
 * Wires the agent-review session state into the tree. Registered by the
 * enterprise registry as a provider wrapper INSIDE the core providers, so it
 * can read the active workspace + branch (and, transitively, subscribe to
 * the SSE bus via `useReviewState`'s `useEventBus()` — the core shell mounts
 * `EventBusProvider` above all of this, see CoreAppShell).
 *
 * Review sessions are keyed on the checked-out branch, not the chat thread:
 * multiple chats on the same branch share one coherent pending-changes view,
 * and cross-thread rejections can't silently clobber each other's edits.
 */
export function ReviewProvider({ children }: { children: ReactNode }) {
  const { workspaceId } = useWorkspace();
  const git = useGit();
  const reviewState = useReviewState(workspaceId, git.status?.branch ?? null);

  return (
    <ReviewContext.Provider value={reviewState}>
      {children}
    </ReviewContext.Provider>
  );
}
