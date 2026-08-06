import type { PullRequestSummary } from '@bevel-software/platform-shared';

/**
 * Who to name as the author of a change request.
 *
 * ONLY `appAuthor` — the app user the backend resolved by matching the hashed
 * identity in the PR body. The `author` field beside it is the GitHub account
 * that physically opened the PR, which is the shared service account
 * (`pr.types.ts`: "Use this in user-facing surfaces — `author.login` is always
 * the shared service account"). In practice `author.login` arrives as an opaque
 * `user-42ee38e1c062`, and `author.name` is the service account's display name,
 * so falling through to either attributes a person's change to the robot or
 * prints a hash where a name belongs.
 *
 * `appAuthor` is absent for PRs opened outside this backend, or when the person
 * has since been removed from the users table. "Someone" is the honest answer
 * to that, and reads correctly in every sentence these surfaces build:
 * "Someone proposed a change", "Waiting on Someone", a byline on its own.
 *
 * BLANK counts as absent, and the trim is not cosmetic. `??` alone lets an
 * empty or whitespace-only name through, which reaches the compare view's
 * blocked banner as "files changed after ⎵ wrote this". Padding is the subtler
 * half: callers take a first name with `split(' ')[0]`, and on `'  Olga'` that
 * yields an empty string from a name that was never empty.
 */
export function changeAuthorName(cr: PullRequestSummary): string {
  return cr.appAuthor?.name?.trim() || 'Someone';
}

/**
 * "today", "yesterday", or a plain date. A change box is read by someone
 * deciding whether to act now, and "3 Aug" answers that worse than "today"
 * does — but an exact timestamp answers it no better, so it stops there.
 * Shared by the skill page's boxes and the Knowledge viewer's.
 */
export function formatWhen(iso: string): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return 'recently';
  // LOCAL calendar days, not elapsed milliseconds: a request from 23:59
  // yesterday is "yesterday" at 00:01, not "today". Future timestamps (clock
  // skew) collapse to "today" rather than a nonsense negative.
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(new Date()) - startOfDay(then)) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return then.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
