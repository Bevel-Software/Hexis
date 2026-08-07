import { Check, X, FileEdit, FilePlus2, FileX2, ArrowRightLeft } from 'lucide-react';
import type { PendingChange } from '@bevel-software/platform-shared';

interface Props {
  change: PendingChange;
  active: boolean;
  busy: boolean;
  onSelect(): void;
  onAccept(): void;
  onReject(): void;
}

function kindLabel(kind: PendingChange['kind']): string {
  switch (kind) {
    case 'added': return 'Added';
    case 'deleted': return 'Deleted';
    case 'renamed': return 'Renamed';
    case 'modified': return 'Modified';
  }
}

function KindIcon({ kind }: { kind: PendingChange['kind'] }) {
  const size = 13;
  switch (kind) {
    case 'added': return <FilePlus2 size={size} className="text-emerald-600" />;
    case 'deleted': return <FileX2 size={size} className="text-red-600" />;
    case 'renamed': return <ArrowRightLeft size={size} className="text-accent" />;
    case 'modified': return <FileEdit size={size} className="text-amber-600" />;
  }
}

export function ReviewFileRow({ change, active, busy, onSelect, onAccept, onReject }: Props) {
  const { kind, path, oldPath, linesAdded, linesRemoved, isBinary } = change;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        // Only treat Enter/Space as "select row" when the keypress originated
        // on the row itself — a keyboard activation of the inner Accept/Reject
        // buttons would otherwise bubble up and trigger selection too.
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
      className={`group flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer transition-colors border ${
        active
          ? 'bg-sunken border-line-strong'
          : 'bg-white border-transparent hover:bg-hover hover:border-line'
      }`}
    >
      <KindIcon kind={kind} />

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 text-xs text-ink truncate">
          <span className="truncate font-mono" title={path}>{path}</span>
          <span className="text-[10px] uppercase tracking-wider text-ink-muted shrink-0">
            {kindLabel(kind)}
          </span>
        </div>
        <div className="flex items-center gap-2 text-[10px] text-ink-muted mt-0.5">
          {oldPath && kind === 'renamed' && (
            <span className="font-mono truncate" title={oldPath}>from {oldPath}</span>
          )}
          {isBinary ? (
            <span>binary</span>
          ) : (
            <>
              {linesAdded !== null && (
                <span className="text-emerald-600">+{linesAdded}</span>
              )}
              {linesRemoved !== null && (
                <span className="text-red-600">−{linesRemoved}</span>
              )}
            </>
          )}
        </div>
      </div>

      <div className="flex items-center gap-1 opacity-70 group-hover:opacity-100">
        <button
          type="button"
          disabled={busy}
          onClick={(e) => {
            e.stopPropagation();
            onReject();
          }}
          title="Reject: restore the original"
          aria-label={`Reject change to ${path}`}
          className="p-1 rounded text-ink-muted hover:text-red-700 hover:bg-red-100 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <X size={13} />
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={(e) => {
            e.stopPropagation();
            onAccept();
          }}
          title="Accept: keep this change"
          aria-label={`Accept change to ${path}`}
          className="p-1 rounded text-ink-muted hover:text-emerald-700 hover:bg-emerald-100 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Check size={13} />
        </button>
      </div>
    </div>
  );
}
