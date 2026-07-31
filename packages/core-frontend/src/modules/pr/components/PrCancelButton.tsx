import { useRef, useState } from 'react';
import { XCircle } from 'lucide-react';
import type { PullRequestDetail } from '@bevel-software/platform-shared';
import { cancelPullRequest } from '../services/pr-cancel.api';
import { friendlyGitError } from '../../git/services/error-messages';
import { PrCancelConfirmDialog } from './PrCancelConfirmDialog';
import { PR_STALE_EVENT } from '../../../core/events';

interface Props {
  detail: PullRequestDetail;
  /** Invoked after a successful cancel. The viewer uses this to close itself + refresh state. */
  onCancelled(): void;
}

/**
 * Secondary destructive action — `Cancel change request`. Mirrors PrMergeButton's
 * shape (hidden on terminal state, disabled when authz lacks, inline error span,
 * double-click guard, dispatches the `bevel:pr-stale` refresh event), but with
 * red text-button styling so the primary purple Apply action stays the focus.
 *
 * Authority is server-computed via `detail.viewerCanCancel` (author OR admin on
 * the base). The button disables — not hides — when the viewer can't cancel,
 * so the affordance is discoverable but its absence-of-permission is explicit.
 */
export function PrCancelButton({ detail, onCancelled }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDialog, setShowDialog] = useState(false);
  // Cancel is irreversible — guard against rapid double-clicks / re-entrant
  // dialog confirms, same as PrMergeButton's mergingRef pattern.
  const cancellingRef = useRef(false);

  if (detail.state !== 'open') return null;

  const allowed = detail.viewerCanCancel;
  const tooltip = allowed
    ? 'Cancel this change request without applying it'
    : 'Only the author or an admin can cancel this change request';

  async function runCancel() {
    if (cancellingRef.current) return;
    cancellingRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await cancelPullRequest(detail.number);
      // Same cross-component refresh signal the merge button uses — the PR
      // list panel and any other open viewers refetch on this event.
      window.dispatchEvent(new CustomEvent(PR_STALE_EVENT));
      setShowDialog(false);
      onCancelled();
    } catch (err) {
      setError(friendlyGitError(err));
    } finally {
      setBusy(false);
      cancellingRef.current = false;
    }
  }

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
        onClick={() => {
          if (!allowed || busy) return;
          setShowDialog(true);
        }}
        disabled={busy}
        aria-disabled={!allowed || undefined}
        title={tooltip}
        aria-label="Cancel change request"
        className="flex items-center gap-1.5 px-2 py-1 text-xs rounded whitespace-nowrap shrink-0 text-red-700 hover:bg-red-50 disabled:text-slate-400 disabled:hover:bg-transparent disabled:cursor-not-allowed aria-disabled:text-slate-400 aria-disabled:hover:bg-transparent aria-disabled:cursor-not-allowed"
      >
        <XCircle size={12} aria-hidden="true" />
        {busy ? 'Cancelling…' : 'Cancel change request'}
      </button>
      {showDialog && (
        <PrCancelConfirmDialog
          busy={busy}
          onConfirm={() => void runCancel()}
          onCancel={() => {
            if (busy) return;
            setShowDialog(false);
          }}
        />
      )}
    </div>
  );
}
