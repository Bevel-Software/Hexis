/**
 * Derive the kebab-cased branch-author localpart from an email.
 *
 * The frontend's `slugifyDraftName` lowercases the email's localpart and
 * replaces non-alphanumeric runs with `-` when building a new branch name
 * (e.g. `Alice@example.com` → `alice/<slug>`, `john.doe@…` → `john-doe/…`).
 * Authorship lookup must use the same transformation so a branch the user
 * could create via the UI is also recognised as theirs on delete.
 *
 * Returns `null` when the email is missing or sanitizes to an empty string —
 * authorship MUST NOT silently fall back to a default identity like `user`.
 * If the helper returned a fallback, any user without a valid localpart
 * would be granted ownership of every `user/...` branch on origin, which is
 * the opposite of the safety property `isBranchAuthoredBy` is meant to
 * provide. The frontend's `slugifyDraftName` can keep its UI-side `user`
 * fallback at the call site because draft creation is not access-gated.
 */
export function branchAuthorLocalpart(
  email: string | null | undefined,
): string | null {
  if (!email) return null;
  const before = email.split('@')[0];
  if (!before) return null;
  const sanitized = before.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  // Sanitized can be all dashes (`-`, `--`) when every char was non-alphanumeric;
  // treat that as no usable identity.
  if (!sanitized.replace(/-/g, '')) return null;
  return sanitized;
}

/**
 * True when `branchName` starts with `<email-localpart>/` — i.e. when the
 * branch matches the UI-created draft convention for this user.
 *
 * The trailing `/` is REQUIRED: without it, `alice-extra/foo` would look
 * authored by `alice@…`, and any user could delete branches whose prefix
 * happens to start with their own localpart. Substring is not authorship.
 */
export function isBranchAuthoredBy(
  branchName: string,
  email: string | null | undefined,
): boolean {
  const localpart = branchAuthorLocalpart(email);
  if (!localpart) return false;
  return branchName.startsWith(`${localpart}/`);
}
