import { useCallback, useEffect, useState } from 'react';
import {
  dismissGroupAccessRequest,
  listGroupAccessRequests,
  type GroupAccessRequestEntry,
} from '../services/groups.api';

/**
 * Pending access requests for the groups the CALLER administers.
 *
 * Standalone rather than folded into `LibraryProvider` because only the admin
 * banner needs it, and for most people the answer is a permanent `[]` — there
 * is no reason for the gallery's data host to carry a list nobody reads.
 *
 * It fetches unconditionally, with no role check anywhere in the browser. The
 * endpoint is admin-gated by construction and answers `[]` (never 403) to
 * everyone else, so "am I an admin of anything" is a question only the server
 * is allowed to answer — and the only honest client-side check is "did I get
 * any rows".
 *
 * Failure degrades to `[]` in silence, matching the group index: a broken
 * requests endpoint must never put an error banner in front of somebody who
 * came to read a skill. `dismiss` is the exception — it is a thing the user
 * just did, so its failure RETHROWS for the caller to toast.
 */

export interface GroupAccessRequestsState {
  requests: GroupAccessRequestEntry[];
  dismiss(id: string): Promise<void>;
  reload(): void;
}

export function useGroupAccessRequests(): GroupAccessRequestsState {
  const [requests, setRequests] = useState<GroupAccessRequestEntry[]>([]);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let cancelled = false;
    listGroupAccessRequests()
      .then((rows) => {
        if (!cancelled) setRequests(rows);
      })
      .catch(() => {
        // Silent by design — see the note above.
      });
    return () => {
      cancelled = true;
    };
  }, [revision]);

  const reload = useCallback(() => setRevision((r) => r + 1), []);

  const dismiss = useCallback(
    async (id: string) => {
      await dismissGroupAccessRequest(id);
      // Drop the row before the refetch lands: the click has to feel done, and
      // a reload that fails must not resurrect a request the server retired.
      setRequests((rows) => rows.filter((r) => r.id !== id));
      setRevision((r) => r + 1);
    },
    [],
  );

  return { requests, dismiss, reload };
}
