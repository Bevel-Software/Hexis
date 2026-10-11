import { deniedSentence, readErrorLead, type ReadFailure } from '../utils/readFailure';
import type { DiffLine } from '../utils/diff';
import { MarkedLines } from './MarkedLines';

/**
 * The file with the change marked in it — one document, not two panes. Removed
 * passages stay in place struck through, added ones sit where they will land,
 * so what you read is the file as it would become.
 *
 * Markdown never reaches this view when both sides are in — it renders
 * through `MarkdownDiffViewer` above. This is the presentation for the files
 * that ARE source (yaml, scripts, config, the access rules file), plus the loading and unreadable
 * states for everything.
 */
export function MarkedFile({
  diff,
  raw,
  failure,
  onRetry,
}: {
  diff: DiffLine[] | null;
  raw: string | null;
  /**
   * Why the copy this pane needs could not be read — `null` when it could.
   * Two forms, whichever side failed: a refusal, which a person has to lift,
   * and everything else, which another attempt might.
   */
  failure?: ReadFailure | null;
  /** Re-fetch this file. Offered only beside the retryable form. */
  onRetry(): void;
}) {
  if (failure) {
    return (
      <p className="py-6 text-center text-detail text-ink-faint">
        {failure.kind === 'denied' ? (
          deniedSentence(failure.folder)
        ) : (
          <>
            {readErrorLead(failure.reason)}{' '}
            {/* The retry IS the sentence's last words — a reader told to try
                again should not then have to find where. */}
            <button
              type="button"
              className="underline underline-offset-2 transition-colors hover:text-ink"
              onClick={onRetry}
            >
              Try again
            </button>
            .
          </>
        )}
      </p>
    );
  }
  if (raw !== null) {
    return (
      <pre className="whitespace-pre-wrap break-words font-mono text-detail leading-relaxed text-ink-muted">
        {raw}
      </pre>
    );
  }
  if (diff === null) {
    return <p className="py-6 text-center text-detail text-ink-faint">Loading…</p>;
  }
  return <MarkedLines lines={diff} />;
}
