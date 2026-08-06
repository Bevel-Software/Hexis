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

/** Keep only characters git branch segments accept; collapse the rest to '-'. */
export function branchSegment(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+/, '')
    .replace(/[.]+$/, '');
  return cleaned || 'user';
}

/**
 * The `suggestions/<who>-<id8>/` prefix every one of this user's suggestion
 * branches carries (`…/knowledge` for the Knowledge bundle, a skill segment
 * for skill proposals). SHARED so the client that names the branch and the
 * server that judges "may this caller delete it" can never disagree. The
 * user-id slice is what makes the identity collision-proof — `branchSegment`
 * alone is lossy (`alex+ops@…` and `alex-ops@…` both clean to `alex-ops`).
 */
export function suggestionsBranchPrefixFor(user: { email: string; id: string }): string {
  const who = branchSegment(user.email.split('@')[0]);
  const id = branchSegment(user.id).slice(0, 8) || 'user';
  return `suggestions/${who}-${id}/`;
}

/**
 * True when `branchName` is one of THIS user's suggestion branches — the
 * authorship rule for the `suggestions/…` namespace, where the plain
 * `<localpart>/` convention of {@link isBranchAuthoredBy} does not apply.
 */
export function isOwnSuggestionsBranch(
  branchName: string,
  user: { email: string | null | undefined; id: string | null | undefined },
): boolean {
  if (!user.email || !user.id) return false;
  return branchName.startsWith(suggestionsBranchPrefixFor({ email: user.email, id: user.id }));
}
