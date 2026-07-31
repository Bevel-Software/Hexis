import { useState } from 'react';
import { Send } from 'lucide-react';

interface Props {
  placeholder?: string;
  submitLabel?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  /** Prefill for edit mode. Uncontrolled — changes after mount are ignored. */
  initialValue?: string;
  onSubmit(body: string): Promise<void>;
  onCancel?(): void;
}

/**
 * Plain textarea + submit button. Keeps its own draft state — parents just
 * observe `onSubmit` and replace/refresh whatever they need. Enter submits,
 * shift+Enter inserts a newline, Escape cancels when `onCancel` is provided.
 */
export function PrCommentComposer({
  placeholder = 'Leave a comment…',
  submitLabel = 'Comment',
  autoFocus,
  disabled,
  initialValue,
  onSubmit,
  onCancel,
}: Props) {
  const [body, setBody] = useState(initialValue ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    const trimmed = body.trim();
    if (!trimmed || busy || disabled) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(trimmed);
      setBody('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to post comment');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <textarea
        autoFocus={autoFocus}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSubmit();
          } else if (e.key === 'Escape' && onCancel) {
            e.preventDefault();
            onCancel();
          }
        }}
        disabled={disabled || busy}
        placeholder={placeholder}
        rows={3}
        className="w-full bg-white border border-slate-200 rounded px-2 py-1.5 text-xs text-slate-900 placeholder-slate-500 resize-none focus:outline-none focus:border-slate-300 disabled:opacity-60"
      />
      {error && <div className="text-[10px] text-red-600">{error}</div>}
      <div className="flex items-center gap-1.5 justify-end">
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="px-2 py-1 text-xs rounded text-slate-600 hover:text-slate-900 hover:bg-slate-100 disabled:opacity-50"
          >
            Cancel
          </button>
        )}
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!body.trim() || busy || disabled}
          className="flex items-center gap-1.5 px-2.5 py-1 text-xs rounded bg-emerald-700 hover:bg-emerald-600 text-white disabled:bg-slate-100 disabled:text-slate-600 disabled:cursor-not-allowed"
        >
          <Send size={11} />
          {busy ? 'Posting…' : submitLabel}
        </button>
      </div>
    </div>
  );
}
