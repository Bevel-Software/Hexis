import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Trash2, Eye, ChevronDown, X } from 'lucide-react';
import type { PendingChange } from '@bevel-software/platform-shared';
import { useReview } from '../state/review.context';
import { useWorkspace } from '../../workspace/state/workspace.context';
import {
  useFileNav,
  useNodeIdNav,
  resolveRelativePath,
  KB_ROUTE_PREFIX,
} from '../../workspace/routing/kb-routes';
import { ReviewFileRow } from './ReviewFileRow';
import { DiffViewer } from './DiffViewer';
import { MarkdownDiffViewer } from './MarkdownDiffViewer';
import { BinaryChangePlaceholder } from './BinaryChangePlaceholder';

function isMarkdownPath(p: string): boolean {
  return /\.md$/i.test(p);
}

function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(i + 1) : p;
}

function kindLabel(kind: PendingChange['kind']): string {
  switch (kind) {
    case 'added': return 'Added';
    case 'deleted': return 'Deleted';
    case 'renamed': return 'Renamed';
    case 'modified': return 'Modified';
  }
}

/**
 * Review panel for pending agent changes. **Opt-in, not a takeover.** The
 * caller (FileViewer) decides when to mount it — the user opens it from the
 * review badge and can dismiss it via `onClose`. It no longer auto-mounts on
 * the existence of changes; that "existence" fact drives the badge instead,
 * keeping "are there changes" and "is the panel open" as separate concerns.
 *
 * Layout: a single top bar with a file-picker dropdown + global actions,
 * then the diff fills the rest. The dropdown replaces the earlier left
 * sidebar so the diff always gets full width — important on mobile where
 * the sidebar was eating most of the screen.
 */
export function ReviewPanel({ onClose }: { onClose?: () => void }) {
  const review = useReview();
  const { refreshFileTree } = useWorkspace();
  const { openFile } = useFileNav();
  // Links inside a rendered diff. Both resolvers navigate relative to
  // `git.status.branch`, which is CORRECT here and only here: this panel
  // reviews the agent's uncommitted changes on the branch you are already
  // standing on, so "the diff's branch" and "the current branch" are the same
  // thing. (The change-request dialog is not in that position, which is why it
  // passes no resolvers — see the comment at its MarkdownDiffViewer call.)
  const { openNodeId } = useNodeIdNav();
  const diffPath = review.fileDiff?.path ?? '';
  const openDiffLink = useCallback(
    (href: string) => {
      // Absolute workspace URLs carry their own branch; running them through
      // resolveRelativePath would treat them as relative to the diffed file
      // and mangle the path. Same guard as MarkdownRenderer's handleFileLink.
      if (href.startsWith(`${KB_ROUTE_PREFIX}/`)) {
        openFile(href);
        return;
      }
      let decoded = href;
      try { decoded = decodeURIComponent(href); } catch { /* leave as-is */ }
      openFile(resolveRelativePath(diffPath, decoded));
    },
    [openFile, diffPath],
  );
  const [busy, setBusy] = useState(false);
  // `busy` alone is not re-entrant-safe: two rapid clicks (or a click + a
  // keyboard activation of the same button) can both read `busy === false`
  // before React schedules the state update. A synchronous ref flips the
  // lock in the same tick so the second invocation sees the first one.
  const busyRef = useRef(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  // Default action scope is the single selected file. The "Apply to all"
  // checkbox (off by default) widens Accept/Delete to every pending change.
  const [applyToAll, setApplyToAll] = useState(false);

  const { session, selectedPath, fileDiff, isLoadingDiff, selectPath } = review;

  // Auto-select the first change whenever the selection is empty but changes exist.
  // Keeps the diff pane populated after an accept/reject collapses the selected row.
  useEffect(() => {
    if (!session || session.changes.length === 0) return;
    if (selectedPath) return;
    const first = session.changes[0];
    selectPath(first.path);
  }, [session, selectedPath, selectPath]);

  // Close the picker on outside click / ESC.
  useEffect(() => {
    if (!pickerOpen) return;
    const onMouseDown = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPickerOpen(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [pickerOpen]);

  const handleSelect = useCallback(
    async (path: string) => {
      setPickerOpen(false);
      await selectPath(path);
      // Also surface the file in the editor so the user can see context alongside
      // the diff. Skip for deleted files — navigating to a missing path would
      // land FileRoute on the file-not-found state.
      const change = session?.changes.find((c) => c.path === path);
      if (change && change.kind !== 'deleted') {
        openFile(path);
      }
    },
    [selectPath, openFile, session],
  );

  const withBusy = useCallback(
    async (fn: () => Promise<void>) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      try {
        await fn();
        // Any accept/reject changes disk state, so refresh the tree in case
        // files were added/removed.
        await refreshFileTree();
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [refreshFileTree],
  );

  if (!session || session.changes.length === 0) return null;

  const count = session.changes.length;
  const selected = session.changes.find((c) => c.path === selectedPath);
  const selectedLabel = selected ? basename(selected.path) : 'Select a file';
  const selectedKind = selected ? kindLabel(selected.kind) : null;

  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-white">
      <div className="min-h-10 border-b border-line flex flex-wrap items-center px-3 py-1.5 gap-2 shrink-0">
        <Eye size={14} className="text-emerald-600 shrink-0" />
        <span className="text-sm font-medium text-ink shrink-0">
          Review agent changes
        </span>
        <span className="text-xs text-ink-muted shrink-0">
          {count} file{count === 1 ? '' : 's'} pending
        </span>

        <div ref={pickerRef} className="relative flex-1 min-w-[10rem] max-w-md">
          <button
            type="button"
            onClick={() => setPickerOpen((v) => !v)}
            aria-haspopup="listbox"
            aria-expanded={pickerOpen}
            className="w-full flex items-center gap-2 px-2.5 py-1 rounded border border-line-strong bg-white hover:bg-hover text-left"
          >
            <span className="text-xs text-ink truncate flex-1" title={selected?.path}>
              {selectedLabel}
            </span>
            {selectedKind && (
              <span className="text-[10px] uppercase tracking-wider text-ink-muted shrink-0">
                {selectedKind}
              </span>
            )}
            <ChevronDown
              size={12}
              className={`text-ink-muted shrink-0 transition-transform ${pickerOpen ? 'rotate-180' : ''}`}
            />
          </button>

          {pickerOpen && (
            <div
              role="listbox"
              className="absolute left-0 right-0 top-full mt-1 max-h-[60vh] overflow-y-auto bg-white border border-line rounded-md shadow-xl z-30 p-1 space-y-1"
            >
              {session.changes.map((change) => (
                <ReviewFileRow
                  key={`${change.kind}:${change.oldPath ?? ''}:${change.path}`}
                  change={change}
                  active={selectedPath === change.path}
                  busy={busy}
                  onSelect={() => handleSelect(change.path)}
                  onAccept={() => withBusy(() => review.acceptOne(change.path))}
                  onReject={() => review.rejectOne(change.path)}
                />
              ))}
            </div>
          )}
        </div>

        <button
          type="button"
          disabled={busy || (!applyToAll && !selected)}
          onClick={() =>
            withBusy(() =>
              applyToAll
                ? review.rejectAll()
                : selected ? review.rejectOne(selected.path) : Promise.resolve(),
            )
          }
          title={applyToAll ? 'Delete every pending change. Restore the originals' : 'Delete this change. Restore the original'}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium text-ink hover:text-red-700 hover:bg-red-100 disabled:opacity-40"
        >
          <Trash2 size={12} />
          Delete
        </button>
        <button
          type="button"
          disabled={busy || (!applyToAll && !selected)}
          onClick={() =>
            withBusy(() =>
              applyToAll
                ? review.acceptAll()
                : selected ? review.acceptOne(selected.path) : Promise.resolve(),
            )
          }
          title={applyToAll ? 'Accept every pending change' : 'Accept this change'}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium bg-emerald-700 hover:bg-emerald-600 text-white disabled:opacity-40"
        >
          <Check size={12} />
          Accept
        </button>
        <label className="flex items-center gap-1.5 text-xs text-ink select-none shrink-0 cursor-pointer">
          <input
            type="checkbox"
            checked={applyToAll}
            onChange={(e) => setApplyToAll(e.target.checked)}
            disabled={busy}
            className="cursor-pointer"
          />
          Apply to all
        </label>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            title="Close review: changes stay pending"
            aria-label="Close review"
            className="ml-1 p-1 rounded text-ink-muted hover:text-ink hover:bg-hover shrink-0"
          >
            <X size={16} />
          </button>
        )}
      </div>

      <div className="flex-1 min-w-0 min-h-0">
        {isLoadingDiff && (
          <div className="h-full flex items-center justify-center text-xs text-ink-muted">
            Loading diff…
          </div>
        )}
        {!isLoadingDiff && !fileDiff && (
          <div className="h-full flex items-center justify-center text-xs text-ink-muted">
            Select a file to see the diff.
          </div>
        )}
        {!isLoadingDiff && fileDiff && fileDiff.isBinary && (
          <BinaryChangePlaceholder payload={fileDiff} />
        )}
        {!isLoadingDiff && fileDiff && !fileDiff.isBinary && (
          isMarkdownPath(fileDiff.path) ? (
            <MarkdownDiffViewer
              payload={fileDiff}
              onOpenFile={openDiffLink}
              onOpenNodeId={openNodeId}
            />
          ) : (
            <DiffViewer payload={fileDiff} />
          )
        )}
      </div>
    </div>
  );
}
