import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import type { FileRendererProps, RendererSaveState } from './types';
import { parseCsv } from './csvUtils';

/**
 * CSV view/edit renderer driven by the parent's `readOnly` prop, mirroring
 * `MarkdownRenderer`:
 *
 *   - `readOnly === true`  → tabular preview (view mode)
 *   - `readOnly === false` → raw comma-separated textarea (edit mode)
 *
 * Editing stays as plain comma-separated text — there is no in-cell editing.
 * The first row is rendered as the table header, matching the convention used
 * by the `.xlsx` viewer. The dirty/save plumbing is identical to the other
 * text-backed renderers.
 */
export function CsvRenderer({
  content,
  savedContent,
  filePath,
  onSave,
  onDirtyChange,
  onValueChange,
  onSaveStateChange,
  readOnly = false,
}: FileRendererProps) {
  const [value, setValue] = useState(content);
  const [savedValue, setSavedValue] = useState(savedContent ?? content);
  const [saveState, setSaveState] = useState<RendererSaveState>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  // Guards against overlapping saves: a rapid second Ctrl/Cmd+S while the
  // first `onSave` is still in flight would otherwise enqueue a concurrent
  // commit. A ref (not `saveState`) so the check sees the latest value
  // synchronously within the same tick.
  const savingRef = useRef(false);

  const dirty = !readOnly && value !== savedValue;

  useEffect(() => {
    setValue(content);
    setSavedValue(savedContent ?? content);
    setSaveState('idle');
    setSaveError(null);
  }, [content, savedContent, filePath]);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    onSaveStateChange?.(saveState);
  }, [saveState, onSaveStateChange]);

  const rows = useMemo(() => (readOnly ? parseCsv(value) : []), [readOnly, value]);
  const columnCount = useMemo(
    () => rows.reduce((max, r) => Math.max(max, r.length), 0),
    [rows],
  );

  const save = useCallback(async (): Promise<boolean> => {
    if (readOnly || value === savedValue) return true;
    if (savingRef.current) return false;
    savingRef.current = true;
    setSaveState('saving');
    setSaveError(null);
    try {
      await onSave(value);
      setSavedValue(value);
      setSaveState('idle');
      return true;
    } catch (err) {
      console.error('[CsvRenderer] save failed:', err);
      setSaveState('error');
      setSaveError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      savingRef.current = false;
    }
  }, [readOnly, value, savedValue, onSave]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const next = e.target.value;
      setValue(next);
      onValueChange?.(next);
    },
    [onValueChange],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        void save();
      }
    },
    [save],
  );

  const showStatusStrip = saveState === 'saving' || (saveState === 'error' && saveError);

  return (
    <div className="flex flex-col h-full">
      {showStatusStrip && (
        <div className="flex items-center gap-2 pb-2 mb-2 border-b border-slate-200 shrink-0">
          {saveState === 'saving' && (
            <span
              role="status"
              aria-live="polite"
              aria-atomic="true"
              className="text-xs text-slate-600"
            >
              Saving…
            </span>
          )}
          {saveState === 'error' && saveError && (
            <span
              role="alert"
              aria-live="assertive"
              aria-atomic="true"
              className="text-xs text-red-600"
            >
              Couldn't save your changes. Try again in a moment.
            </span>
          )}
        </div>
      )}

      {readOnly ? (
        <div className="flex-1 overflow-auto">
          {rows.length === 0 || columnCount === 0 ? (
            <div className="flex items-center justify-center h-full text-slate-600 text-sm">
              This file is empty.
            </div>
          ) : (
            <table className="border-collapse text-sm">
              <tbody>
                {rows.map((row, rIdx) => (
                  <tr key={rIdx}>
                    {Array.from({ length: columnCount }, (_, cIdx) => {
                      const cell = row[cIdx] ?? '';
                      const Tag = rIdx === 0 ? 'th' : 'td';
                      return (
                        <Tag
                          key={cIdx}
                          className={`border border-slate-200 px-2 py-1 align-top whitespace-pre-wrap ${
                            rIdx === 0
                              ? 'bg-slate-50 text-slate-900 font-medium text-left'
                              : 'text-slate-700'
                          }`}
                        >
                          {cell}
                        </Tag>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : (
        <textarea
          className="flex-1 w-full bg-transparent text-sm text-slate-700 font-mono whitespace-pre-wrap break-words leading-relaxed resize-none outline-none"
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          spellCheck={false}
          autoFocus
        />
      )}
    </div>
  );
}
