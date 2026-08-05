import { useEffect, useState } from 'react';
import { useGit } from '../../git/state/git.context';
import { formatRelativeTime } from '../../../lib/utils';

export interface LastCommit {
  /** First name only — the rail is a summary, not an audit log. */
  author: string;
  /** "3d ago", or an absolute date past ~a month. */
  relative: string;
}

/**
 * Who last touched this file, and when.
 *
 * `git.fetchFileHistory` is a plain context method, so the rail can call it
 * directly — but it is NOT free and it is NOT cached. Every file opened with
 * the rail up costs one request, and `FileHistoryPanel` will fetch the same
 * history again if the reader then opens it. That is why `enabled` exists: a
 * closed rail must cost nothing, which is the whole justification for
 * defaulting it closed.
 *
 * A failure yields `null`, and the rail simply omits the row. A file with no
 * commits yet (created on this draft, never committed) yields `null` too —
 * both are "we cannot say", and neither is worth an error state on a page
 * about a document.
 */
export function useLastCommit(path: string | null, enabled: boolean): LastCommit | null {
  const { fetchFileHistory } = useGit();
  // Keyed by the path the answer is ABOUT, and read back through a match on
  // the current path. That is what makes the reset derived rather than an
  // effect that sets state synchronously — and it also closes the window where
  // the previous file's commit would flash in the rail for one frame after a
  // tab switch.
  const [answer, setAnswer] = useState<{ path: string; commit: LastCommit | null } | null>(null);

  useEffect(() => {
    if (!enabled || !path) return;
    let cancelled = false;
    fetchFileHistory(path, 1)
      .then((history) => {
        if (cancelled) return;
        const latest = history[0];
        setAnswer({
          path,
          commit: latest
            ? {
                author: latest.authorName.split(' ')[0] || latest.authorName,
                relative: formatRelativeTime(latest.committedAt),
              }
            : null,
        });
      })
      .catch(() => {
        // "We cannot say" and "there is nothing to say" render identically —
        // the rail omits the row. Neither is worth an error state on a page
        // about a document.
        if (!cancelled) setAnswer({ path, commit: null });
      });
    return () => {
      cancelled = true;
    };
  }, [path, enabled, fetchFileHistory]);

  if (!enabled || !path || answer?.path !== path) return null;
  return answer.commit;
}
