import { useState, useCallback, useEffect } from 'react';
import type { FileRendererProps, RendererSaveState } from './types';

export function TextRenderer({
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

  const dirty = !readOnly && value !== savedValue;

  // Reset editor state whenever EITHER the content or the filePath changes.
  // File identity matters: switching between two files with identical content
  // must still reset so a prior save/dirty state doesn't leak across files.
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

  const save = useCallback(async (): Promise<boolean> => {
    if (readOnly || value === savedValue) return true;
    setSaveState('saving');
    setSaveError(null);
    try {
      await onSave(value);
      setSavedValue(value);
      setSaveState('idle');
      return true;
    } catch (err) {
      setSaveState('error');
      setSaveError(err instanceof Error ? err.message : 'Failed to save');
      return false;
    }
  }, [readOnly, value, savedValue, onSave]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const next = e.target.value;
    setValue(next);
    onValueChange?.(next);
  }, [onValueChange]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      void save();
    }
  }, [save]);

  return (
    <div className="flex flex-col h-full min-h-0">
      <textarea
        className="w-full flex-1 min-h-0 bg-transparent text-sm text-slate-700 font-mono whitespace-pre-wrap break-words leading-relaxed resize-none outline-none"
        value={value}
        onChange={readOnly ? undefined : handleChange}
        onKeyDown={readOnly ? undefined : handleKeyDown}
        readOnly={readOnly}
        spellCheck={false}
      />
      {!readOnly && (
        <div className="pt-2 text-xs min-h-5">
          {saveState === 'saving' && <span className="text-slate-600">Saving…</span>}
          {saveState === 'error' && saveError && <span className="text-red-600">{saveError}</span>}
        </div>
      )}
    </div>
  );
}
