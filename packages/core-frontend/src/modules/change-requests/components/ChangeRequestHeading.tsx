import { useState } from 'react';
import { withoutAffectedOwners, type PullRequestSummary } from '@bevel-software/platform-shared';
import { Button } from '../../../shared/components';
import { cn } from '../../../lib/utils';
import { changeAuthorName } from '../utils/author';

/**
 * The top of the change-request view — what is being asked, by whom, on
 * which branch, and why in the author's words. Shared by the review view of
 * an open request and the finished view of an applied or closed one, which
 * differ in everything below it but never in this.
 */
export function ChangeRequestHeader({
  cr,
  onClose,
}: {
  cr: PullRequestSummary;
  onClose(): void;
}) {
  const author = changeAuthorName(cr);
  return (
    <div className="flex items-start gap-4 px-8 pt-7">
      <div className="min-w-0 flex-1">
        <p className="text-label font-semibold uppercase text-ink-faint">Change request</p>
        <h1 className="mt-1 text-title font-medium text-ink">{cr.title}</h1>
        <p className="mt-2 flex flex-wrap items-center gap-2 text-detail text-ink-muted">
          <span>{author}</span>
          <span aria-hidden="true" className="text-ink-faint">·</span>
          <span className="font-mono">{cr.branch}</span>
        </p>
      </div>
      <Button variant="quiet" size="sm" onClick={onClose} aria-label="Close change request">
        ✕
      </Button>
    </div>
  );
}

/** The author's reason as a one-line quote with Read more, or nothing at all. */
export function AuthorsReason({ body }: { body: string | undefined }) {
  const why = authorsReason(body);
  const [whyExpanded, setWhyExpanded] = useState(false);
  /**
   * Whether the one-line view is actually hiding anything — a short reason
   * with a pointless "Read more" beside it would be a button that does
   * nothing visible. Length is a heuristic (true truncation depends on the
   * viewport), erring toward showing the toggle: a newline always overflows a
   * single line, and ~90 characters approximates one row of the quote.
   */
  const whyOverflows = !!why && (why.includes('\n') || why.length > 90);
  return (
    <>
      {/* Why, in the author's words. Omitted rather than faked when the
          request carries no description — an empty quote block reads as the
          author having said nothing worth reading.

          ONE line by default, because agents write essays: the decision is
          made on the diff below, and every line the description takes is a
          line the file grid (the dialog's one flexible region) loses. Read
          more opens the whole thing (self-scrolling past half the surface,
          so even an essay never pushes the files off screen); Hide folds it
          back to the line. */}
      {why && (
        <blockquote
          className={cn(
            'mx-8 mt-5 shrink-0 border-l-2 border-line-strong pl-4 text-body text-ink',
            whyExpanded && 'max-h-[50vh] overflow-y-auto',
          )}
        >
          {whyExpanded ? (
            <>
              <span className="whitespace-pre-wrap">{why}</span>{' '}
              <button
                type="button"
                className="text-detail font-medium text-ink-faint transition-colors hover:text-ink"
                onClick={() => setWhyExpanded(false)}
              >
                Hide
              </button>
            </>
          ) : (
            <span className="flex items-baseline gap-3">
              <span className="min-w-0 flex-1 truncate">{why}</span>
              {whyOverflows && (
                <button
                  type="button"
                  className="shrink-0 text-detail font-medium text-ink-faint transition-colors hover:text-ink"
                  onClick={() => setWhyExpanded(true)}
                >
                  Read more
                </button>
              )}
            </span>
          )}
        </blockquote>
      )}
    </>
  );
}

/**
 * The author's reason, or nothing.
 *
 * A change request's body is part human and part machine: the backend appends
 * an `## Affected owners` block (and hidden identity markers) to whatever the
 * author wrote, and our propose flow writes no description at all — so the body
 * is USUALLY pure machinery. Rendering it as a pull-quote under the title
 * presents a routing table as the reason someone wants this change. The body is
 * cut at the LAST line that is exactly `## Affected owners` — the block is
 * always appended last, and the author's own `##` headings stay — by the
 * same shared `withoutAffectedOwners` the agent tools' `authorsDescription`
 * uses. Every HTML comment is dropped, Hexis's hidden markers and an
 * author's own alike, as this view always has:
 * a comment is text its writer chose not to show, and the quote renders as
 * plain text, so keeping one would print it raw. What survives is quoted
 * only if a human actually wrote it.
 */
function authorsReason(body: string | undefined): string | null {
  if (!body) return null;
  const human = withoutAffectedOwners(body)
    // Every comment: nothing in one was written to be shown.
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();
  return human.length > 0 ? human : null;
}
