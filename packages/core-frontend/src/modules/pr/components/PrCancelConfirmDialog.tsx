import { useEffect, useRef } from 'react';
import { AlertTriangle, X, XCircle } from 'lucide-react';

interface Props {
  busy: boolean;
  onConfirm(): void;
  onCancel(): void;
}

/**
 * Plain are-you-sure confirm for the destructive Cancel action. No checkbox —
 * unlike the merge bypass dialog, there's no rights-elevation happening here.
 * Server already gates the action behind author-or-admin authority; the dialog
 * is a behavioral gate (intent confirmation), not an authorization gate.
 */
export function PrCancelConfirmDialog({ busy, onConfirm, onCancel }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  // Move initial focus into the dialog, trap Tab inside it, and restore focus
  // to the previously-focused element on close — same pattern as DirtySwitchDialog.
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    confirmRef.current?.focus();

    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (!busy) onCancel();
        return;
      }
      if (e.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = panel.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      previouslyFocused?.focus?.();
    };
  }, [busy, onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-white/60"
      role="dialog"
      aria-modal="true"
      aria-labelledby="pr-cancel-confirm-title"
    >
      <div
        ref={panelRef}
        className="w-[28rem] max-w-[90vw] bg-white border border-line rounded-md shadow-xl"
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-line">
          <AlertTriangle size={14} className="text-red-600 shrink-0" aria-hidden="true" />
          <h2
            id="pr-cancel-confirm-title"
            className="text-sm font-medium text-ink flex-1"
          >
            Cancel this change request?
          </h2>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            aria-label="Keep change request open"
            className="p-1 rounded text-ink-muted hover:text-ink hover:bg-hover disabled:opacity-40"
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>

        <div className="px-4 py-3 space-y-2">
          <p className="text-xs text-ink">
            This won't delete your draft — you can still open a new change request
            from the same draft later.
          </p>
          <p className="text-xs text-ink-muted">
            The cancellation is recorded in the change request history.
          </p>
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-line">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="px-3 py-1 text-xs rounded text-ink hover:bg-hover disabled:opacity-40"
          >
            Keep open
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="flex items-center gap-1.5 px-3 py-1 text-xs rounded bg-red-600 hover:bg-red-500 text-white disabled:bg-sunken disabled:text-ink-muted disabled:cursor-not-allowed"
          >
            <XCircle size={12} aria-hidden="true" />
            {busy ? 'Cancelling…' : 'Cancel change request'}
          </button>
        </div>
      </div>
    </div>
  );
}
