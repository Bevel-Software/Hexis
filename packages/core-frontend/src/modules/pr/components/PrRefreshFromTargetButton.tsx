import { useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { protectedBranchDisplayName, type PullRequestDetail } from '@bevel-software/shared';
import { refreshChangeRequestFromTarget } from '../services/pr-merge.api';
import { GitApiError } from '../../git/services/git.api';
import { useCrCreationPort } from '../../../core/registry';
import { PR_STALE_EVENT } from '../../../core/events';

interface Props {
  detail: PullRequestDetail;
  /** Invoked after a successful refresh so the viewer can re-fetch the detail. */
  onRefreshed(): void;
}

/**
 * "Update from target" — re-runs the auto-merge of the target branch into
 * this change request's source branch (PLAN §1). The button is the
 * counterpart to the auto-merge that happens on CR open; users hit it
 * when the target advances mid-review and they want the diff to reflect
 * what the merge would actually produce now.
 *
 * Conflicts come back as a 409 with the `change-request-conflicts`
 * structured payload. **The user never sees the conflict directly** — per
 * the design rule "if it doesn't work out of the box, the agent fixes it
 * not the user", the conflict is handed to the change-request port (the
 * enterprise registry seeds a chat prompt and auto-sends it so the agent
 * walks its conflict-resolution flow). Other 409s / 5xx (auth, infra) are
 * still shown inline since they're not the "two versions disagree" case.
 */
export function PrRefreshFromTargetButton({ detail, onRefreshed }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlightRef = useRef(false);
  const crPort = useCrCreationPort();

  if (detail.state !== 'open') return null;

  const baseLabel = protectedBranchDisplayName(detail.base) ?? detail.base;

  async function run() {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await refreshChangeRequestFromTarget(detail.number);
      window.dispatchEvent(new CustomEvent(PR_STALE_EVENT));
      onRefreshed();
    } catch (err) {
      if (err instanceof GitApiError) {
        const body = err.body;
        if (
          body && typeof body === 'object' && 'kind' in body &&
          (body as { kind?: string }).kind === 'change-request-conflicts' &&
          crPort?.resolveCrConflicts
        ) {
          // Defensive narrowing: `body` came off the wire, so the array
          // shape is asserted but the element type isn't actually checked
          // by the JSON parser. Filter to strings so downstream code (the
          // enterprise prompt builder) gets the type its signature claims.
          const rawPaths = (body as { conflictedPaths?: unknown }).conflictedPaths;
          const paths = Array.isArray(rawPaths)
            ? rawPaths.filter((item): item is string => typeof item === 'string')
            : [];
          crPort.resolveCrConflicts({
            kind: 'refresh',
            changeRequestNumber: detail.number,
            base: detail.base,
            conflictedPaths: paths,
          });
          // No inline error — the chat panel shows the agent picking it up.
          // (Without a registered resolver the 409 falls through to the
          // inline error below instead.)
          return;
        }
        setError(err.message);
        return;
      }
      setError(err instanceof Error ? err.message : "Couldn't refresh from target");
    } finally {
      setBusy(false);
      inFlightRef.current = false;
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
        onClick={() => void run()}
        disabled={busy}
        title={`Pull the latest ${baseLabel} into this draft so the diff reflects what the merge would produce now.`}
        className="flex items-center gap-1.5 px-2.5 py-1 text-xs rounded whitespace-nowrap shrink-0 text-slate-700 bg-slate-100 hover:bg-slate-200 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <RefreshCw size={12} className={busy ? 'animate-spin' : ''} />
        {busy ? 'Refreshing…' : `Update from ${baseLabel}`}
      </button>
    </div>
  );
}
