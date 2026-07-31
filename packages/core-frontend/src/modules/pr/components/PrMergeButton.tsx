import { useEffect, useRef, useState } from 'react';
import { GitMerge } from 'lucide-react';
import { protectedBranchDisplayName, type PullRequestDetail } from '@bevel-software/platform-shared';
import { mergePullRequest } from '../services/pr-merge.api';
import { fetchPrDetail } from '../services/pr-detail.api';
import { PrMergeConfirmDialog } from './PrMergeConfirmDialog';
import { useCrCreationPort } from '../../../core/registry';
import { PR_STALE_EVENT } from '../../../core/events';
import { useEventBus } from '../../workflow/state/event-bus.context';

/**
 * Safety net for the async merge: if neither a `change-request-merged` nor a
 * `change-request-merge-failed` event lands within this window (a dropped SSE
 * connection, a backend crash mid-merge), stop the spinner and tell the user to
 * refresh. Generous — `gh pr merge` alone has a 60s server budget.
 */
const MERGE_RESULT_TIMEOUT_MS = 180_000;

/**
 * Polling fallback cadence while a merge is in flight. The merge outcome
 * normally arrives over the SSE event bus, but that connection can drop (proxy
 * 502 / backend restart mid-merge) and take the `change-request-merged` event
 * with it — leaving the button stuck on "Applying…" even though the apply
 * landed. So we ALSO poll the CR's real state as a backstop: once it leaves
 * `open`, the apply succeeded. Bounded by `MERGE_RESULT_TIMEOUT_MS` above.
 */
const MERGE_POLL_INTERVAL_MS = 4_000;

interface Props {
  detail: PullRequestDetail;
  /** Invoked after a successful merge. The viewer uses this to close itself + refresh state. */
  onMerged(): void;
  /**
   * Drop the "to {base}" suffix from the button label so it stays narrow.
   * The full sentence still appears in the `title` tooltip. The change-request
   * header passes this so the button + overflow menu + close `X` all fit
   * even when the chat panel is open.
   */
  compact?: boolean;
}

/**
 * Three-state merge action:
 *   - Hidden for merged/closed PRs.
 *   - Disabled (neutral) when a hard block applies (no files, etc.).
 *   - Yellow when soft warnings exist (pending md-with-owner approvals) —
 *     clicking opens a confirm dialog with a bypass checkbox.
 *   - Purple (default) when the gate is clean — one click merges directly.
 */
export function PrMergeButton({ detail, onMerged, compact = false }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showBypassDialog, setShowBypassDialog] = useState(false);
  const crPort = useCrCreationPort();
  // Merge is irreversible — guard with a ref so a rapid double-click (or the
  // button + dialog-confirm both firing in the same tick) can't issue two
  // `gh pr merge` calls. The `busy` state alone has a one-render lag window
  // where both click handlers still see `busy=false` even though the first
  // has already kicked off the request.
  const mergingRef = useRef(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const bus = useEventBus();

  const stopMerging = () => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    mergingRef.current = false;
    setBusy(false);
  };

  // Shared success path — run when the apply lands, whether that's signalled by
  // the `change-request-merged` SSE event below or detected by the polling
  // fallback in `runMerge` (the event is lost if the SSE connection drops
  // mid-merge, which is what leaves the button stuck on "Applying…").
  function succeed() {
    stopMerging();
    setShowBypassDialog(false);
    // Refresh the PR sidebar immediately (same mechanism the share dialog uses).
    window.dispatchEvent(new CustomEvent(PR_STALE_EVENT));
    onMerged();
  }

  // Polling fallback for a lost merge-result event. `fetchPrDetail` with
  // `fresh` bypasses the 30s detail cache so a just-merged CR shows its
  // terminal state promptly. Failures (often the same outage that dropped the
  // SSE event) are swallowed — the next tick retries until the merge lands or
  // the safety timeout fires.
  async function pollMergeState() {
    if (!mergingRef.current) return;
    try {
      const latest = await fetchPrDetail(detail.number, { fresh: true });
      if (!mergingRef.current) return;
      if (latest.state !== 'open') succeed();
    } catch {
      /* transient — keep polling */
    }
  }

  // The merge runs in the background server-side (the POST only acks with 202),
  // so its outcome arrives over the event bus. We react only to events for THIS
  // change request that THIS button kicked off (`mergingRef`) — other tabs /
  // users get the same global success event but shouldn't drive this button's
  // close-and-seed-chat side effects.
  useEffect(() => {
    if (!bus) return;
    const offMerged = bus.subscribe('change-request-merged', (e) => {
      if (!mergingRef.current || e.number !== detail.number) return;
      succeed();
    });
    const offFailed = bus.subscribe('change-request-merge-failed', (e) => {
      if (!mergingRef.current || e.number !== detail.number) return;
      stopMerging();
      if (e.conflicts && crPort?.resolveCrConflicts) {
        // **The user never sees the conflict.** Hand it to the change-request
        // port — the enterprise registry seeds the chat composer with a
        // resolution request and auto-sends it; the agent walks the resolution
        // flow (same behaviour as the old synchronous path, now event-driven).
        // Without a registered resolver the failure falls through to the
        // inline error below.
        crPort.resolveCrConflicts({
          kind: 'apply',
          changeRequestNumber: detail.number,
          base: detail.base,
          conflictedPaths: [],
        });
        setShowBypassDialog(false);
        return;
      }
      // Close the bypass dialog (if the merge was triggered through it) before
      // surfacing the error, so the banner isn't stranded behind the dialog.
      setShowBypassDialog(false);
      setError(e.reason || "Couldn't apply changes");
    });
    return () => {
      offMerged();
      offFailed();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bus, detail.number, detail.base, onMerged, crPort]);

  // Clear a pending safety timeout only when the button truly unmounts (a merge
  // that succeeds unmounts it) — NOT on every re-subscribe above, which would
  // drop the timer for an in-flight merge.
  useEffect(() => () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    if (pollRef.current) clearInterval(pollRef.current);
  }, []);

  // Merged/closed PRs don't get the button at all — nothing to do.
  if (detail.state !== 'open') return null;

  const hardBlocked = !detail.mergeableInBevel;
  const hasWarnings = detail.mergeWarnings.length > 0;
  // Yellow vs purple is decided by warnings only when there's no hard block.
  const needsBypass = !hardBlocked && hasWarnings;
  // Bypass is admin-only on the backend (`mergePr` throws `BypassAuthError`
  // on a 403 for non-admins). Surface the same gate here so the button is
  // disabled with explanatory copy instead of "click → bypass dialog → 403".
  const cannotBypass = needsBypass && !detail.viewerCanBypassMerge;

  // Capitalised display for protected branches ("Current company state" /
  // "Target company state"); fall back to the raw name for any non-protected
  // base (rare in practice — most apply targets are one of the two protected
  // branches — but keep the path open).
  const protectedLabel = protectedBranchDisplayName(detail.base);
  const baseDisplay = protectedLabel ?? detail.base;
  const baseInTooltip = protectedLabel !== null ? `the ${baseDisplay}` : baseDisplay;

  const tooltip = hardBlocked
    ? (detail.mergeBlockedReasons.length > 0
        ? detail.mergeBlockedReasons.join('\n')
        : `Not ready to apply to ${baseInTooltip}`)
    : cannotBypass
      ? `Waiting on ${detail.mergeWarnings.length} confirmation${detail.mergeWarnings.length === 1 ? '' : 's'} — only an admin can apply now`
      : needsBypass
        ? `${detail.mergeWarnings.length} confirmation${detail.mergeWarnings.length === 1 ? '' : 's'} pending — click to review`
        : `All files confirmed — apply this draft to ${baseInTooltip}`;

  async function runMerge(opts: { bypass?: boolean }) {
    if (mergingRef.current) return;
    mergingRef.current = true;
    setBusy(true);
    setError(null);
    try {
      // 202 ack only — the merge runs in the background and reports via the
      // event-bus subscription above. Arm a safety timeout so a lost event
      // can't leave the button spinning forever.
      await mergePullRequest(detail.number, opts);
      // A merged/failed event can land before this 202 ack resolves (SSE is a
      // separate connection); only arm the safety timeout if this attempt is
      // still in flight, so the timer can't outlive it and fire during a retry.
      if (!mergingRef.current) return;
      timeoutRef.current = setTimeout(() => {
        if (!mergingRef.current) return;
        stopMerging();
        setError('Applying is taking longer than expected — refresh to check its status.');
      }, MERGE_RESULT_TIMEOUT_MS);
      // Backstop the SSE event with state polling — see MERGE_POLL_INTERVAL_MS.
      pollRef.current = setInterval(() => void pollMergeState(), MERGE_POLL_INTERVAL_MS);
    } catch (err) {
      // The POST itself failed (auth / bad request / network) — no background
      // job started, so reset immediately rather than wait for an event.
      stopMerging();
      setShowBypassDialog(false);
      setError(err instanceof Error ? err.message : "Couldn't apply changes");
    }
  }

  function handleClick() {
    if (busy || hardBlocked || cannotBypass) return;
    if (needsBypass) {
      setShowBypassDialog(true);
      return;
    }
    void runMerge({});
  }

  const buttonClass = needsBypass
    ? 'bg-amber-600 hover:bg-amber-500 text-white'
    : 'bg-purple-700 hover:bg-purple-600 text-white';

  return (
    <div className="flex items-center gap-2">
      {error && (
        <span
          role="alert"
          aria-live="assertive"
          className="text-[11px] text-red-700 max-w-xs truncate"
          title={error}
        >
          {error}
        </span>
      )}
      <button
        type="button"
        onClick={handleClick}
        disabled={busy || hardBlocked || cannotBypass}
        title={tooltip}
        className={`flex items-center gap-1.5 px-2.5 py-1 text-xs rounded whitespace-nowrap shrink-0 disabled:bg-sunken disabled:text-ink-muted disabled:cursor-not-allowed ${buttonClass}`}
      >
        <GitMerge size={12} />
        {busy
          ? 'Applying…'
          : cannotBypass
            ? `Waiting on confirmations`
            : compact
              ? 'Apply draft'
              : `Apply draft to ${baseDisplay}`}
      </button>
      {showBypassDialog && (
        <PrMergeConfirmDialog
          warnings={detail.mergeWarnings}
          base={detail.base}
          busy={busy}
          onConfirm={() => void runMerge({ bypass: true })}
          onCancel={() => setShowBypassDialog(false)}
        />
      )}
    </div>
  );
}
