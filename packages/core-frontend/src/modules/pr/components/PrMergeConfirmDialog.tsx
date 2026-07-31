import { useEffect, useState } from 'react';
import { AlertTriangle, GitMerge, X } from 'lucide-react';
import { protectedBranchDisplayName } from '@bevel-software/shared';

interface Props {
  /** Soft warnings from the gate — one line per pending approval. */
  warnings: string[];
  /** Base branch the draft applies to — surfaced in the title + confirm button. */
  base: string;
  busy: boolean;
  onConfirm(): void;
  onCancel(): void;
}

/**
 * Shown when the user clicks Merge on a PR with pending approvals. Lists the
 * approvers the merge would skip and requires an explicit bypass checkbox
 * before the Merge button in the dialog becomes enabled — so "click yellow,
 * click confirm, done" isn't possible without acknowledging the warning.
 */
export function PrMergeConfirmDialog({ warnings, base, busy, onConfirm, onCancel }: Props) {
  const [bypassAck, setBypassAck] = useState(false);
  const baseDisplay = protectedBranchDisplayName(base) ?? base;

  // Escape to dismiss. Attach on mount, detach on unmount — standard modal pattern.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !busy) onCancel();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-white/60"
      role="dialog"
      aria-modal="true"
      aria-labelledby="pr-merge-confirm-title"
    >
      <div className="w-[28rem] max-w-[90vw] bg-white border border-slate-200 rounded-md shadow-xl">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-200">
          <AlertTriangle size={14} className="text-amber-600 shrink-0" />
          <h2
            id="pr-merge-confirm-title"
            className="text-sm font-medium text-slate-900 flex-1"
          >
            Apply draft to {baseDisplay} without all confirmations?
          </h2>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            aria-label="Cancel"
            className="p-1 rounded text-slate-600 hover:text-slate-900 hover:bg-slate-100 disabled:opacity-40"
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>

        <div className="px-4 py-3 space-y-3">
          <p className="text-xs text-slate-700">
            This draft has not been approved by:
          </p>
          <ul className="text-xs text-slate-700 space-y-1 max-h-48 overflow-y-auto bg-white/50 border border-slate-200 rounded px-3 py-2">
            {warnings.map((w, i) => (
              <li key={i} className="flex gap-1.5">
                <span className="text-amber-600 shrink-0">•</span>
                <span className="break-words">{w}</span>
              </li>
            ))}
          </ul>
          <label className="flex items-start gap-2 text-xs text-slate-700 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={bypassAck}
              onChange={(e) => setBypassAck(e.target.checked)}
              disabled={busy}
              className="mt-0.5 accent-amber-500"
            />
            <span>
              Bypass approval requirements and apply anyway.{' '}
              <span className="text-slate-600">
                The bypassed list is recorded in the merge commit body.
              </span>
            </span>
          </label>
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-slate-200">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="px-3 py-1 text-xs rounded text-slate-700 hover:bg-slate-100 disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy || !bypassAck}
            className="flex items-center gap-1.5 px-3 py-1 text-xs rounded bg-amber-600 hover:bg-amber-500 text-white disabled:bg-slate-100 disabled:text-slate-600 disabled:cursor-not-allowed"
          >
            <GitMerge size={12} aria-hidden="true" />
            {busy ? 'Applying…' : `Apply to ${baseDisplay} with bypass`}
          </button>
        </div>
      </div>
    </div>
  );
}
