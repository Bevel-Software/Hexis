import { useState } from 'react';
import { Banner, Button, Surface } from '../../../../shared/components';

interface SkillFileEditorProps {
  file: string;
  /** The text as it stands now — what the submitted text will be diffed against. */
  base: string;
  /**
   * What submitting DOES — the same editor serves both verdicts of the
   * per-file ACL:
   *   - `propose`: the text lands on the caller's suggestion branch as a
   *     change request; nothing moves until the owner approves.
   *   - `edit`: the text saves straight to the default branch — the caller
   *     may write the file, so there is nobody to wait on.
   * The mode only changes the words (button, reassurance line): what gets
   * submitted and how the diff is computed are identical.
   */
  mode: 'edit' | 'propose';
  /** Who has to say yes — read only in `propose` mode, for the line under the editor. */
  owner: string;
  onCancel(): void;
  /** Resolves when the text has landed (on the branch, or on the default branch). */
  onSubmit(next: string): Promise<void>;
}

/**
 * Propose a change by editing the file — the prototype's `.editbox` (line 284).
 *
 * The whole file is editable rather than one selected phrase, because the unit
 * people actually propose in is a passage: rewriting a step usually means
 * touching the sentence before it. What gets stored is still a diff; the
 * textarea is only how you say what you mean.
 *
 * The line under it is the entire reassurance this flow needs. Editing a file
 * in a shared library reads as destructive, and it isn't — nothing moves until
 * the owner says so — so the editor says that where the fear is, not in a
 * tooltip somewhere.
 */
export function SkillFileEditor({
  file,
  base,
  mode,
  owner,
  onCancel,
  onSubmit,
}: SkillFileEditorProps) {
  const [text, setText] = useState(base);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * A `<textarea>` hands its value back with LF endings whatever went in, so a
   * CRLF file would come back rewritten line-for-line. Both comparisons and the
   * submitted text are put back into the file's OWN convention, which keeps a
   * one-word edit a one-line diff.
   */
  const crlf = base.includes('\r\n');
  const toFileEndings = (s: string) => (crlf ? s.replace(/\r?\n/g, '\r\n') : s);
  const lf = (s: string) => s.replace(/\r\n?/g, '\n');

  /**
   * Exact comparison — NOT trimmed. Adding a trailing newline, stripping
   * trailing spaces, or fixing the indent on the first line are real edits, and
   * a trimmed guard answered every one of them with "Nothing changed yet".
   *
   * The LF normalisation is not the same kind of leniency and has to stay: the
   * textarea can only ever produce LF, so against a CRLF `base` a raw `===`
   * would report "changed" on a file nobody touched — and since `toFileEndings`
   * converts back on the way out, that would open a change request git sees no
   * diff in at all.
   */
  const unchanged = lf(text) === lf(base);

  async function submit() {
    if (unchanged) {
      setError('Nothing changed yet: edit the text first.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(toFileEndings(text));
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : mode === 'edit'
            ? "Couldn't save your change."
            : "Couldn't send your change.",
      );
      setBusy(false);
    }
  }

  return (
    <Surface tone="surface" radius="lg" elevation="card" className="mt-4 overflow-hidden">
      <div className="flex min-h-11 items-center gap-3 border-b border-line px-3.5 py-2">
        <span className="truncate font-mono text-meta text-ink-muted">{file} — editing</span>
      </div>

      {/* `rows` rather than a height class alone: the intrinsic row count is
          what a textarea falls back to, so a class that fails to apply leaves a
          two-line box to edit a whole file in. */}
      <textarea
        aria-label={mode === 'edit' ? `Edit ${file}` : `Propose changes to ${file}`}
        spellCheck={false}
        rows={22}
        className="block max-h-[60vh] min-h-64 w-full resize-y bg-sunken px-6 py-4 font-mono text-detail leading-relaxed text-ink outline-none"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />

      {error && (
        <Banner tone="danger" role="alert" className="mx-3.5 mt-3">
          {error}
        </Banner>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-line px-3 py-2.5">
        <span className="mr-auto text-meta text-ink-faint">
          {mode === 'edit'
            ? 'Saves for everyone. Agents pick it up the next time they connect.'
            : `Nothing changes until ${owner} approves it.`}
        </span>
        <Button variant="quiet" size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button variant="primary" size="sm" onClick={() => void submit()} disabled={busy}>
          {mode === 'edit' ? (busy ? 'Saving…' : 'Save') : busy ? 'Sending…' : 'Propose changes'}
        </Button>
      </div>
    </Surface>
  );
}
