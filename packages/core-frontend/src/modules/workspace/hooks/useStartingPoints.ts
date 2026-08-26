import { useEffect, useMemo, useState } from 'react';
import type { FileTreeEntry } from '@bevel-software/platform-shared';
import { listRecentPages } from '../services/workspace.api';
import { suggestedPages } from '../utils/fileTree';

/**
 * Where to start, for a reader with nothing open.
 *
 * The answer a knowledge base should give is what the team has been working
 * on, so the offer is the most recently changed pages the reader may open.
 * That is a question only the branch's history can answer: the file tree
 * carries no timestamps, and choosing by position in the tree instead answers
 * a different question badly.
 *
 * `suggestedPages` stays as the fallback for the two cases history cannot
 * cover — a fresh branch with nothing committed yet, and a reader whose
 * recent work is all in folders they cannot open — and for the moment before
 * the request lands, so the empty state never renders offer-less and then
 * pops.
 *
 * `enabled` exists because the fetch is only worth making while the reader is
 * actually looking at the empty state. FileViewer calls this on every render,
 * including the common one where a file is open and these offers are never
 * shown; without the flag every file opened would cost a request for a list
 * nobody sees.
 *
 * The answer is keyed by the workspace it is ABOUT and read back through a
 * match on the current one. That is what keeps the previous branch's pages
 * from lingering on screen for a frame after a branch switch, and it makes
 * the reset derived rather than a second effect.
 */
export function useStartingPoints(
  workspaceId: string | null,
  fileTree: FileTreeEntry | null,
  limit: number,
  enabled: boolean,
): FileTreeEntry[] {
  const fallback = useMemo(() => suggestedPages(fileTree, limit), [fileTree, limit]);
  const [answer, setAnswer] = useState<{ workspaceId: string; pages: FileTreeEntry[] } | null>(
    null,
  );

  useEffect(() => {
    if (!enabled || !workspaceId) return;
    let cancelled = false;
    // `listRecentPages` never rejects: an unreachable history leaves the
    // reader with the tree walk, which is a worse offer but still an offer.
    listRecentPages(workspaceId, limit).then((pages) => {
      if (!cancelled) setAnswer({ workspaceId, pages });
    });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, limit, enabled]);

  const recent = answer?.workspaceId === workspaceId ? answer.pages : [];
  return recent.length > 0 ? recent : fallback;
}
