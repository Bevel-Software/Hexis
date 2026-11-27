/**
 * Derive the kebab-cased branch-author localpart from an email.
 *
 * The frontend's `slugifyDraftName` lowercases the email's localpart and
 * replaces non-alphanumeric runs with `-` when building a new branch name
 * (e.g. `Alice@example.com` → `alice/<slug>`, `john.doe@…` → `john-doe/…`).
 * Authorship lookup must use the same transformation so a branch the user
 * could create via the UI is also recognised as theirs on delete.
 *
 * Returns `null` when the email is missing, sanitizes to an empty string, or
 * sanitizes to a prefix no branch can carry (`_ops@…` gives `-ops`, and a
 * branch name cannot start with `-`), so no branch could be theirs by it —
 * authorship MUST NOT silently fall back to a default identity like `user`.
 * If the helper returned a fallback, any user without a valid localpart
 * would be granted ownership of every `user/...` branch on origin, which is
 * the opposite of the safety property `isBranchAuthoredBy` is meant to
 * provide. A person with no usable localpart gets their own `suggestions/`
 * prefix instead ({@link ownDraftPrefixFor}), which the branch switcher and
 * the server both use.
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
  // `<localpart>/…` is the whole branch name's start, and git (and
  // `assertValidBranchName`) refuse a name that starts with `-`.
  if (sanitized.startsWith('-')) return null;
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
 * The `suggestions/<who>-<id8>/` prefix this user's Knowledge suggestion
 * bundle (`…/knowledge`) carries, and their drafts when their address has no
 * usable localpart ({@link ownDraftPrefixFor}). A skill proposal is named by
 * the library's own rule (`suggestions/<who>/<skill>`) and is not under it.
 * SHARED so the client that names the branch and the server that judges "may
 * this caller delete it" can never disagree. The user-id slice is what makes
 * the identity collision-proof — `branchSegment` alone is lossy (`alex+ops@…`
 * and `alex-ops@…` both clean to `alex-ops`).
 */
export function suggestionsBranchPrefixFor(user: { email: string; id: string }): string {
  const who = branchSegment(user.email.split('@')[0]);
  const id = branchSegment(user.id).slice(0, 8) || 'user';
  return `suggestions/${who}-${id}/`;
}

/**
 * The prefix that makes a draft `user`'s own, to manage and delete later:
 * `<email-localpart>/`, or, for an address with no usable localpart, their
 * {@link suggestionsBranchPrefixFor} prefix, which exists for every signed-in
 * user. {@link isBranchAuthoredBy} or {@link isOwnSuggestionsBranch}
 * recognises either as theirs.
 */
export function ownDraftPrefixFor(user: { email: string; id: string }): string {
  const local = branchAuthorLocalpart(user.email);
  return local !== null ? `${local}/` : suggestionsBranchPrefixFor(user);
}

/**
 * True when `branchName` carries one of the two prefixes that make a branch
 * `user`'s own ({@link ownDraftPrefixFor} gives a new draft one of them): the
 * authorship half of "may this person delete it", read by the server's rule
 * and by the branch switcher's delete button alike.
 */
export function isOwnBranch(
  branchName: string,
  user: { email: string | null | undefined; id: string | null | undefined },
): boolean {
  return isBranchAuthoredBy(branchName, user.email) || isOwnSuggestionsBranch(branchName, user);
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
