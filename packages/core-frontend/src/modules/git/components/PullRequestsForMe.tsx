import { useEffect, useRef, useState } from 'react';
import { ChevronRight, Check, X, Clock } from 'lucide-react';
import type { PullRequestSummary } from '@bevel-software/platform-shared';
import { cn } from '../../../lib/utils';
import { Badge } from '../../../shared/components';
import { listPullRequestsForMe } from '../services/pr.api';
import { friendlyGitError } from '../services/error-messages';
import { useGit } from '../state/git.context';
import { ChangeRequestDialog } from '../../change-requests/components/ChangeRequestDialog';
import { PR_STALE_EVENT } from '../../../core/events';

const POLL_INTERVAL_MS = 60_000;

export function PullRequestsForMe() {
  const git = useGit();
  const [prs, setPrs] = useState<PullRequestSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(true);
  /** The request opened full-screen in the shared change-request dialog. */
  const [openCr, setOpenCr] = useState<PullRequestSummary | null>(null);
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
  // A queue you notice, not one you live in. With nothing waiting there is
  // nothing to notice, so the dock stays out of the tree's way entirely — the
  // permanent "Nothing waiting for your review." row was a line of chrome that
  // was true almost all of the time. An error still shows: "we could not ask"
  // is not the same answer as "there is nothing".
  if (loading || (!error && prs.length === 0)) return null;

  return (
    // The prototype's `.crdock` (proto:730-750): pinned under the tree behind
    // one hairline, a disclosure header with an amber count, and rows in the
    // same two type sizes the tree above and the Library nav use, so the whole
    // sidebar is one typographic system rather than three.
    <div className="flex max-h-60 shrink-0 flex-col border-t border-line px-2">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        // The visible label is the prototype's; the accessible name keeps the
        // SCOPE in words, because this queue is deliberately narrower than the
        // dots in the tree — it is the requests that are yours to act on.
        aria-label="Change requests for you"
        className="flex items-center gap-[7px] px-1.5 pt-2.5 pb-2 text-label uppercase text-ink-faint transition-colors hover:text-ink"
      >
        <span className="flex w-3 flex-none items-center justify-center">
          <ChevronRight
            size={11}
            className={cn('transition-transform duration-150', expanded && 'rotate-90')}
          />
        </span>
        <span className="flex-1 text-left">Change requests</span>
        {prs.length > 0 && (
          <Badge tone="wait" size="xs">
            {prs.length}
          </Badge>
        )}
      </button>

      {expanded && (
        <div className="flex flex-col gap-px overflow-y-auto pb-1.5">
          {error && <div className="pl-[25px] pr-1.5 py-2 text-meta text-danger">{error}</div>}
          {!error &&
            prs.map((pr) => <PrRow key={pr.number} pr={pr} onOpen={() => setOpenCr(pr)} />)}
        </div>
      )}

      {/* The SHARED change-request dialog — the same surface a change box's
          "Read the whole change" opens, unscoped: this queue spans the whole
          repo. Resolving refreshes every listener via the stale event; this
          list is one of them. */}
      {openCr && (
        <ChangeRequestDialog
          cr={openCr}
          onClose={() => setOpenCr(null)}
          onResolved={() => {
            setOpenCr(null);
            window.dispatchEvent(new Event(PR_STALE_EVENT));
          }}
        />
      )}
    </div>
  );
}

function PrRow({ pr, onOpen }: { pr: PullRequestSummary; onOpen(): void }) {
  const touched = pr.touchedNodePaths.length;
  // `appAuthor` is optional — it is absent for a request opened outside this
  // backend, or after the app user was removed. `author.login` is always
  // there; never render "undefined" at somebody.
  const who = pr.appAuthor?.name ?? pr.author.login;
  // The summary endpoint doesn't carry app-level approval state (that only
  // comes from the detail endpoint, which is per-PR). We show the GitHub
  // review badge as-is until the user opens the request and sees the real
  // approval progress — the dialog is authoritative.
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      className="group block cursor-pointer rounded-sm pl-[25px] pr-[7px] py-1.5 transition-colors hover:bg-hover"
      title={pr.title}
    >
      <div className="flex min-w-0 gap-1.5 text-ui text-ink-muted group-hover:text-ink">
        <span className="flex-none tabular-nums text-ink-faint">#{pr.number}</span>
        {/* The ellipsis has to live on the TEXT, not on the flex row — a flex
            container clips its children without ever drawing one. */}
        <span className="min-w-0 truncate">{pr.title}</span>
      </div>
      <div className="mt-px flex items-center gap-2 text-meta text-ink-faint">
        <span className="truncate">{who}</span>
        <ReviewBadge review={pr.review} />
        {touched > 0 && (
          <span className="flex-none">
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
