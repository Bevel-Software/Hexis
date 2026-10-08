import { sanitizeErrorText } from './error-messages';

/**
 * What a failed pull was about, read off the sanitized error. git's words are
 * sorted into the four things a person can do something about, and both
 * readers of a failure take their text from here: the sentence the banner
 * shows, and the phrase the change-request port hands the assistant. One
 * sorting, so the two cannot drift apart.
 */
export type PullFailureKind = 'conflict' | 'local-changes' | 'connection' | 'unknown';

export function pullFailureKind(error: unknown): PullFailureKind {
  const sanitized = sanitizeErrorText(error).toLowerCase();
  if (/\b(conflict|conflicts|merge conflict|would be overwritten)\b/.test(sanitized)) return 'conflict';
  if (/\b(uncommitted|local changes|working tree|dirty|stash)\b/.test(sanitized)) return 'local-changes';
  if (
    /\b(network|auth(?:entication|orization)?|credential|permission denied|unauthorized|forbidden|timeout|timed out|could not resolve host|failed to connect|401|403)\b/.test(
      sanitized,
    )
  ) {
    return 'connection';
  }
  return 'unknown';
}

/**
 * The phrase the change-request port is handed. The enterprise registry
 * splices it into the chat composer, where the user sees it, so it carries no
 * git vocabulary — no "merge conflict", "uncommitted", "working tree",
 * "stash", "HEAD". The assistant's own prompt knows the mechanics.
 */
export function pullFailurePhrase(error: unknown): string {
  switch (pullFailureKind(error)) {
    case 'conflict':
      return 'two versions of the same file need to be reconciled';
    case 'local-changes':
      return 'there are local changes that need to be sorted out first';
    case 'connection':
      return 'a connection or permission problem';
    default:
      return 'something unexpected went wrong';
  }
}

/**
 * Why getting the latest changes failed, as a sentence a person reads under
 * the banner's heading; null when nothing more is known than that it failed.
 * Never the sanitized error itself: scrubbed of secrets it still speaks git
 * ("working tree has uncommitted changes").
 */
export function pullFailureDetail(error: unknown): string | null {
  switch (pullFailureKind(error)) {
    case 'conflict':
      return 'A page was changed both here and by a teammate, and the two versions need combining first.';
    case 'local-changes':
      return 'There are changes here that haven’t been saved to the knowledge base yet.';
    case 'connection':
      return 'Your git host couldn’t be reached, or refused this deployment. Check the connection and the repository access.';
    default:
      return null;
  }
}

/** The whole alert: that it failed, and why when that is known. */
export function describePullFailure(error: unknown): string {
  const detail = pullFailureDetail(error);
  return detail ? `Couldn’t get the latest changes. ${detail}` : 'Couldn’t get the latest changes.';
}
