import type { PullRequestDetail } from '@bevel-software/platform-shared';

/** The app's date format ("Oct 10, 2026"), the one `formatRelativeTime` falls back to. */
function formatDay(at: Date): string {
  return at.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** How long after an apply it still reads "just now". */
const JUST_NOW_MS = 60_000;

/**
 * The finished view's one status line — how the request ended, in a
 * sentence:
 *
 *   - "Applied by <name> on <date>.", "Applied by <name> just now." within
 *     the first minute, "Applied on <date>." when no applier is recorded;
 *   - "Closed on <date>. Nothing from it was applied.";
 *   - "Closed on <date> when the knowledge base moved to another repository.
 *     Nothing from it was applied."
 *
 * `now` is taken when the detail arrives, not on every render: "just now"
 * does not turn into the date while the view stays open (reopening shows it).
 */
export function finishedStatusLine(
  detail: Pick<PullRequestDetail, 'state' | 'finished'>,
  now: number = Date.now(),
): string {
  const f = detail.finished ?? null;
  const at = f?.at ? new Date(f.at) : null;
  const when = at && !Number.isNaN(at.getTime()) ? at : null;
  const on = when ? ` on ${formatDay(when)}` : '';
  if (detail.state === 'merged') {
    // A server clock a little ahead of this one still reads as "just now".
    const justNow = when !== null && Math.abs(now - when.getTime()) < JUST_NOW_MS;
    const by = f?.appliedBy?.name ? ` by ${f.appliedBy.name}` : '';
    return `Applied${by}${justNow ? ' just now' : on}.`;
  }
  if (f?.closedReason === 'repository-replaced') {
    return `Closed${on} when the knowledge base moved to another repository. Nothing from it was applied.`;
  }
  return `Closed${on}. Nothing from it was applied.`;
}
