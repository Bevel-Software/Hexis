import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, GitPullRequest, Check, X, Clock } from 'lucide-react';
import type { PullRequestSummary } from '@bevel-software/platform-shared';
import { listPullRequestsForMe } from '../services/pr.api';
import { friendlyGitError } from '../services/error-messages';
import { useGit } from '../state/git.context';
import { usePrViewer } from '../../pr/state/pr-viewer.context';
import { PR_STALE_EVENT } from '../../../core/events';

const POLL_INTERVAL_MS = 60_000;

export function PullRequestsForMe() {
  const git = useGit();
  const [prs, setPrs] = useState<PullRequestSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(true);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(false);
  // Snapshot of branches from the previous PR list so we can detect which
  // PRs vanished (merged / closed on GitHub) between polls and offer their
  // orphaned local branches to the auto-prune path.
  const prevBranchesRef = useRef<Set<string>>(new Set());

  const available = git.availability === 'ready';
  const deleteBranch = git.deleteBranch;
  const refreshBranches = git.refreshBranches;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!available) return;

    let cancelled = false;

    async function fetchOnce(opts: { fresh?: boolean } = {}) {
      try {
        const data = await listPullRequestsForMe(opts);
        if (cancelled || !mountedRef.current) return;

        // Detect PRs whose branch just vanished from our list — that's the
        // "PR merged + remote branch deleted" case. Ask the backend to prune
        // the local counterpart iff origin agrees it's gone (the backend's
        // `onlyIfNoRemote` guard rejects if the branch is still on origin).
        const nextBranches = new Set(data.map((p) => p.branch));
        const vanished: string[] = [];
        for (const name of prevBranchesRef.current) {
          if (!nextBranches.has(name)) vanished.push(name);
        }
        prevBranchesRef.current = nextBranches;

        if (vanished.length > 0) {
          // Settle each prune independently — one branch still lingering on
          // origin shouldn't block the others. We ignore errors: the common
          // 4xx here is "still exists on origin", which just means "don't
          // prune yet".
          const results = await Promise.allSettled(
            vanished.map((name) => deleteBranch(name, { onlyIfNoRemote: true })),
          );
          const anyPruned = results.some((r) => r.status === 'fulfilled');
          if (anyPruned) {
            // deleteBranch already calls refreshBranches per deletion, but
            // that races with this effect. Explicit refresh here keeps the
            // switcher list in sync with the pruned state.
            refreshBranches().catch(() => {});
          }
        }

        setPrs(data);
        setError(null);
      } catch (err) {
        if (cancelled || !mountedRef.current) return;
        setError(friendlyGitError(err));
      } finally {
        if (!cancelled && mountedRef.current) setLoading(false);
      }
    }

    function schedule() {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (document.hidden) return;
      timerRef.current = setTimeout(async () => {
        await fetchOnce();
        if (!cancelled && mountedRef.current) schedule();
      }, POLL_INTERVAL_MS);
    }

    function handleVisibility() {
      if (document.hidden) {
        if (timerRef.current) clearTimeout(timerRef.current);
      } else {
        // fetchOnce swallows its own errors, but guard the chain anyway so a stray
        // synchronous throw doesn't bubble out as an unhandled rejection.
        fetchOnce()
          .then(() => {
            if (!cancelled && mountedRef.current) schedule();
          })
          .catch((e) => {
            console.error('[PullRequestsForMe] poll failed', e);
          });
      }
    }

    // Immediate refresh whenever something in the app may have mutated the
    // PR list (share dialog opened one, agent turn finished a create/delete
    // via `gh`, etc.). Saves the user from waiting up to POLL_INTERVAL_MS
    // for the next background refresh.
    function handlePrStale() {
      // fresh=true skips the server cache — the event fires because the UI has
      // a specific reason to think the list just changed (PR create via gh or
      // the share dialog, agent turn end), and a stale 30s cache would defeat
      // the point of asking for an immediate refresh.
      fetchOnce({ fresh: true }).catch((e) => {
        console.error('[PullRequestsForMe] refresh-on-stale failed', e);
      });
    }

    fetchOnce()
      .then(() => {
        if (!cancelled && mountedRef.current) schedule();
      })
      .catch((e) => {
        console.error('[PullRequestsForMe] initial load failed', e);
      });
    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener(PR_STALE_EVENT, handlePrStale);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener(PR_STALE_EVENT, handlePrStale);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [available, deleteBranch, refreshBranches]);

  if (!available) return null;

  return (
    <div className="border-t border-slate-200 shrink-0 max-h-60 flex flex-col">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-600 hover:text-slate-900 hover:bg-white/60"
      >
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <GitPullRequest size={12} />
        <span className="flex-1 text-left uppercase tracking-wide">Change requests for you</span>
        {!loading && prs.length > 0 && (
          <span className="text-[10px] bg-slate-100 text-slate-700 rounded px-1.5 py-0.5">
            {prs.length}
          </span>
        )}
      </button>

      {expanded && (
        <div className="flex-1 overflow-y-auto">
          {loading && (
            <div className="px-3 py-2 text-xs text-slate-600">Loading…</div>
          )}
          {!loading && error && (
            <div className="px-3 py-2 text-xs text-red-600">{error}</div>
          )}
          {!loading && !error && prs.length === 0 && (
            <div className="px-3 py-2 text-xs text-slate-600">Nothing waiting for your review.</div>
          )}
          {!loading && !error && prs.map((pr) => (
            <PrRow key={pr.number} pr={pr} />
          ))}
        </div>
      )}
    </div>
  );
}

function PrRow({ pr }: { pr: PullRequestSummary }) {
  const touched = pr.touchedNodePaths.length;
  const { openPr } = usePrViewer();
  // The summary endpoint doesn't carry app-level approval state (that only
  // comes from the detail endpoint, which is per-PR). We show the GitHub
  // review badge as-is until the user opens the PR and sees the real
  // Bevel-side progress. The header bar inside the viewer is authoritative.
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => openPr(pr.number)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openPr(pr.number);
        }
      }}
      className="block px-3 py-1.5 hover:bg-white/60 border-b border-slate-200 last:border-b-0 group cursor-pointer"
      title={pr.title}
    >
      <div className="flex items-center gap-1.5 text-xs text-slate-900">
        <span className="text-slate-600 font-mono shrink-0">#{pr.number}</span>
        <span className="truncate flex-1">{pr.title}</span>
      </div>
      <div className="flex items-center gap-2 mt-0.5 text-[10px] text-slate-600">
        <span className="truncate">{pr.appAuthor?.name ?? pr.author.login}</span>
        <ReviewBadge review={pr.review} />
        {touched > 0 && (
          <span className="shrink-0">
            {touched} file{touched === 1 ? '' : 's'}
          </span>
        )}
      </div>
    </div>
  );
}

function ReviewBadge({ review }: { review: PullRequestSummary['review'] }) {
  if (review.changesRequested > 0) {
    return (
      <span className="flex items-center gap-0.5 text-red-600 shrink-0">
        <X size={10} />
        {review.changesRequested}
      </span>
    );
  }
  if (review.approvals > 0) {
    return (
      <span className="flex items-center gap-0.5 text-emerald-600 shrink-0">
        <Check size={10} />
        {review.approvals}
      </span>
    );
  }
  if (review.pendingLogins.length > 0) {
    return (
      <span className="flex items-center gap-0.5 text-amber-600 shrink-0">
        <Clock size={10} />
        {review.pendingLogins.length}
      </span>
    );
  }
  return null;
}
