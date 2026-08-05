import { useCallback } from 'react';
import { mergePullRequest } from '../../pr/services/pr-merge.api';
import { cancelPullRequest } from '../../pr/services/pr-cancel.api';
import { useLibrary } from '../state/library-data';
import { useLibraryToast } from '../state/toast';

/**
 * Answering a join request — the two actions behind the owner-side banner,
 * shared by the gallery and the group page (both render the banner, and the
 * handlers drifted apart once already).
 *
 * A join request is a change request, so the actions are change-request
 * actions: approving MERGES it (the merge gate does the real authorization —
 * an approver must be able to write the touched `access.md`), dismissing
 * REJECTS it. Neither reads the outcome: a merge lands asynchronously, so
 * both paths just refetch and let the next render tell the truth.
 *
 * Approving reloads the group index too — the requester becomes a reader, so
 * the roster and the caller's own verdicts change. Dismissing cannot change
 * any verdict, so it only refreshes the change-request list.
 */
export interface JoinRequestActions {
  approve(number: number): Promise<void>;
  dismiss(number: number): Promise<void>;
}

export function useJoinRequestActions(): JoinRequestActions {
  const data = useLibrary();
  const toast = useLibraryToast();

  const approve = useCallback(
    async (number: number) => {
      try {
        await mergePullRequest(number);
        toast('Approved — merging their access now.');
      } catch {
        toast("Couldn't approve that — try again.");
      }
      data.reload();
      data.reloadGroups();
    },
    [data, toast],
  );

  const dismiss = useCallback(
    async (number: number) => {
      try {
        await cancelPullRequest(number);
      } catch {
        toast("Couldn't dismiss that — try again.");
      }
      data.reload();
    },
    [data, toast],
  );

  return { approve, dismiss };
}
