import { useEffect, useRef, useState, type RefObject } from 'react';

interface SuggestChangeProps {
  /** The file-viewer element whose text selections trigger the chip. */
  containerRef: RefObject<HTMLElement | null>;
  /** Raw content of the file on screen (selection must occur in it verbatim). */
  raw: string | null;
  /** Commit the suggestion; resolves when it landed on the suggestion branch. */
  onSubmit(find: string, replace: string, note: string): Promise<void>;
}

interface ChipState {
  text: string;
  left: number;
  top: number;
}

/**
 * Select-text → "Suggest a change" chip → small form. The selection must be a
 * single-line stretch that appears verbatim in the raw file content (rendered
 * markdown can differ from source — same guard as the approved mock).
 */
export function SuggestChange({ containerRef, raw, onSubmit }: SuggestChangeProps) {
  const [chip, setChip] = useState<ChipState | null>(null);
  const [form, setForm] = useState<ChipState | null>(null);
  const [replaceValue, setReplaceValue] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onMouseUp(e: MouseEvent) {
      if (rootRef.current?.contains(e.target as Node)) return;
      const sel = window.getSelection();
      const text = sel?.toString().trim() ?? '';
      const container = containerRef.current;
      if (
        !container ||
        !sel ||
        sel.rangeCount === 0 ||
        !sel.anchorNode ||
        !container.contains(sel.anchorNode) ||
        text.length <= 2 ||
        text.includes('\n')
      ) {
        setChip(null);
        return;
      }
      const r = sel.getRangeAt(0).getBoundingClientRect();
      setChip({
        text,
        left: Math.max(8, r.left + r.width / 2 - 70),
        top: Math.max(8, r.top - 40),
      });
    }
    document.addEventListener('mouseup', onMouseUp);
    return () => document.removeEventListener('mouseup', onMouseUp);
  }, [containerRef]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && (form || chip)) {
        e.stopPropagation();
        setForm(null);
        setChip(null);
      }
    }
    if (!form && !chip) return;
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [form, chip]);

  async function submit() {
    if (!form) return;
    const replace = replaceValue.trim();
    if (!replace || replace === form.text) {
      setForm(null);
      return;
    }
    if (raw !== null && !raw.includes(form.text)) {
      setError('Select a plain stretch of text to suggest on.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(form.text, replace, note.trim());
      setForm(null);
      window.getSelection()?.removeAllRanges();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save your suggestion.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div ref={rootRef}>
      {chip && !form && (
        <button
          type="button"
          className="fixed z-[85] flex items-center gap-1.5 rounded-full bg-slate-800 px-3.5 py-1.5 text-xs font-semibold text-white shadow-[0_8px_24px_rgba(22,35,58,0.32)] hover:bg-slate-700"
          style={{ left: chip.left, top: chip.top }}
          onClick={() => {
            setForm(chip);
            setReplaceValue(chip.text);
            setNote('');
            setError(null);
            setChip(null);
          }}
        >
          Suggest a change
        </button>
      )}
      {form && (
        <div
          className="fixed z-[85] w-[290px] rounded-[14px] border border-slate-200 bg-white p-4 shadow-[0_16px_44px_rgba(22,35,58,0.24)]"
          style={{
            left: Math.min(Math.max(8, form.left), window.innerWidth - 300),
            top: Math.min(Math.max(8, form.top + 34), window.innerHeight - 260),
          }}
          role="dialog"
          aria-label="Suggest a change"
        >
          <h5 className="mb-2 text-[12.5px] font-bold text-slate-800">Suggest a change</h5>
          <div className="mb-1 max-h-[58px] overflow-auto rounded-md bg-[#fdecec] px-2 py-1 font-mono text-[11px] text-[#b91c1c] line-through">
            {form.text}
          </div>
          <label className="mb-1 mt-2 block text-[10px] font-bold uppercase tracking-[.07em] text-slate-400">
            Your version
            <textarea
              rows={3}
              className="mt-1 w-full resize-y rounded-lg border border-slate-200 px-2 py-1.5 text-xs font-normal normal-case tracking-normal text-slate-800 outline-none focus:border-[#0d9488]"
              value={replaceValue}
              onChange={(e) => setReplaceValue(e.target.value)}
            />
          </label>
          <label className="mb-1 mt-2 block text-[10px] font-bold uppercase tracking-[.07em] text-slate-400">
            Note (optional)
            <input
              className="mt-1 w-full rounded-lg border border-slate-200 px-2 py-1.5 text-xs font-normal normal-case tracking-normal text-slate-800 outline-none focus:border-[#0d9488]"
              placeholder="Why this change?"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          {error && <div className="mt-1 text-[11px] text-[#c53030]">{error}</div>}
          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              className="rounded-[10px] border border-slate-200 px-3.5 py-2 text-[12.5px] font-semibold text-slate-500 hover:text-slate-800"
              onClick={() => setForm(null)}
              disabled={busy}
            >
              Cancel
            </button>
            <button
              type="button"
              className="rounded-[10px] bg-gradient-to-br from-[#0d9488] to-[#0f766e] px-4 py-2 text-[12.5px] font-bold text-white shadow-[0_4px_14px_rgba(13,148,136,0.22)] disabled:opacity-60"
              onClick={() => void submit()}
              disabled={busy}
            >
              {busy ? 'Saving…' : 'Suggest'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
