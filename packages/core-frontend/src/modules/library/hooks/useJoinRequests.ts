import { useCallback, useEffect, useState } from 'react';
import { DEFAULT_BRANCH } from '@bevel-software/platform-shared';
import { grantAccess } from '../../access/api';
import { cancelPullRequest } from '../../pr/services/pr-cancel.api';
import {
  listJoinRequests,
  reconcileJoinRequest,
  type JoinProposal,
  type JoinRequest,
} from '../services/plugins.api';
import { useLibraryToast } from '../state/toast.context';

/**
 * The join requests one plugin's managers can answer, and the two ways to
 * answer them.
 *
 * ACCEPTING IS A GRANT, NOT A MERGE. A proposal is "give this principal this
 * verb on the plugin folder", so accepting it calls the ordinary access-grant
 * API — the same endpoint the Manage-access dialog uses, with the same gate,
 * lock and commit. The request's branch is never merged, so nothing else it
 * carries can ride in on an approval, and a request naming five people can be
 * answered with two yeses and three ignores.
 *
 * The request then retires ITSELF: it is open exactly while its `access.md`
 * grants something the default branch does not, so once the accepted grant
 * lands the diff is empty and the server closes it and deletes the branch.
 * `reconcile` just asks for that check immediately instead of waiting for the
 * next listing (which does it too).
 *
 * Fetching is unconditional and degrades to `[]` — the endpoint answers `[]`
 * to non-managers rather than 403, so "am I a manager here" stays a question
 * only the server answers.
 */
export interface JoinRequestsState {
  requests: JoinRequest[];
  /** Grant one proposal, then settle the request if that was the last one. */
  accept(request: JoinRequest, proposal: JoinProposal): Promise<void>;
  /** Decline the whole request — reject the change request. */
  decline(request: JoinRequest): Promise<void>;
  reload(): void;
}

export function useJoinRequests(plugin: string, folder: string | null): JoinRequestsState {
  const [requests, setRequests] = useState<JoinRequest[]>([]);
  const [revision, setRevision] = useState(0);
  const toast = useLibraryToast();

  useEffect(() => {
    let cancelled = false;
    listJoinRequests(plugin)
      .then((rows) => {
        if (!cancelled) setRequests(rows);
      })
      .catch(() => {
        // Silent: a manager surface that fails must not put an error banner in
        // front of somebody who came to read a skill.
      });
    return () => {
      cancelled = true;
    };
  }, [plugin, revision]);

  const reload = useCallback(() => setRevision((r) => r + 1), []);

  const accept = useCallback(
    async (request: JoinRequest, proposal: JoinProposal) => {
      if (!folder) return;
      try {
        await grantAccess(encodeURIComponent(DEFAULT_BRANCH), {
          path: folder,
          kind: 'folder',
          verb: proposal.verb,
          principal: proposal.principal,
        });
      } catch (err) {
        toast(err instanceof Error ? err.message : "Couldn't grant that: try again.", 'danger');
        setRevision((r) => r + 1);
        return;
      }
      // Drop the accepted proposal locally so the row goes immediately; the
      // refetch below is what makes it true.
      setRequests((rows) =>
        rows.map((r) =>
          r.number === request.number
            ? {
                ...r,
                proposals: r.proposals.filter(
                  (p) => !(p.id === proposal.id && p.verb === proposal.verb),
                ),
              }
            : r,
        ),
      );
      toast(`${proposal.label} now has ${proposal.verb} access.`);
      await reconcileJoinRequest(plugin, request.number).catch(() => false);
      setRevision((r) => r + 1);
    },
    [folder, plugin, toast],
  );

  const decline = useCallback(
    async (request: JoinRequest) => {
      try {
        await cancelPullRequest(request.number);
      } catch {
        toast("Couldn't dismiss that: try again.", 'danger');
      }
      setRevision((r) => r + 1);
    },
    [toast],
  );

  return { requests, accept, decline, reload };
}
