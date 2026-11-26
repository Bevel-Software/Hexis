/**
 * THE reading of an email-domain allow-list (`ALLOWED_EMAIL_DOMAINS`, the
 * Single sign-on card's field, a tenant record's list): comma- or
 * whitespace-separated, lower-cased, a leading `@` or `.` tolerated —
 * `a.com, @B.com` → `['a.com', 'b.com']`. Empty means no guard.
 *
 * Every place that reads such a list reads it through this, so the value an
 * operator wrote means the same domains wherever it is read.
 */
export function parseEmailDomainList(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((d) => d.trim().toLowerCase().replace(/^[@.]+/, ''))
    .filter((d) => d.length > 0);
}
