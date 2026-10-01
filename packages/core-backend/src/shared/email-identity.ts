import { createHash } from 'node:crypto';

/**
 * THE canonical spelling of an email address: trimmed, lowercased.
 *
 * Everything that compares two addresses, keys a row by one, or hashes one
 * has to agree on this — a grant written `Mia@x.io` and a caller arriving as
 * `mia@x.io ` are the same person, and any reader that decides otherwise
 * denies access the knowledge base plainly gives. The rule was written out
 * inline in a dozen places (`user.email.trim().toLowerCase()`) and named
 * once in the access grammar; this is the one place it lives now, and the
 * grammar's `canonicalEmail` is this function.
 *
 * Deliberately NOT full RFC normalization: no dot-folding, no plus-tag
 * stripping, no IDN mapping. Those differ per provider, and a rule that
 * guessed would silently merge two identities the operator's directory
 * treats as distinct.
 */
export function canonicalEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Canonical user-identity hash: SHA-256 over the {@link canonicalEmail} form,
 * returned as hex. Used wherever Bevel needs a stable email-derived identifier
 * without storing the raw email — PR author-id markers, self-approval
 * detection, the reverse lookup behind `findEmailByHash`.
 *
 * All callers MUST use this single function, and it must normalise exactly as
 * `canonicalEmail` does: a drift between the two would silently de-attribute
 * every PR the bot opens, because the hash embedded in the PR body would no
 * longer match the hash computed at lookup time. That is not hypothetical —
 * the access resolver carried its own copy of this expression, used by the
 * very lookup that has to agree with it.
 */
export function hashEmail(email: string): string {
  return createHash('sha256').update(canonicalEmail(email)).digest('hex');
}
