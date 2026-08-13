import { Check, Copy } from 'lucide-react';
import { useCopyFeedback } from './useCopyFeedback';

/** Read-only snippet with a copy button, for the no-key connection configs. */
export function CopyBlock({
  label,
  value,
  rows,
}: {
  label: string | null;
  value: string;
  rows: number;
}) {
  const { copied, copy } = useCopyFeedback();

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        {label !== null && <div className="text-xs font-medium text-ink">{label}</div>}
        <button
          onClick={() => copy(value)}
          className="ml-auto p-1 rounded hover:bg-hover text-ink-muted"
          aria-label={label ? `Copy: ${label}` : 'Copy to clipboard'}
          title="Copy to clipboard"
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>
      <textarea
        readOnly
        value={value}
        rows={rows}
        className="w-full font-mono text-[11px] bg-sunken border border-line rounded px-2 py-1.5 resize-none"
        onFocus={(e) => e.currentTarget.select()}
      />
    </div>
  );
}
