import { createHash } from 'node:crypto';

/**
 * Canonical user-identity hash: SHA-256 over the trimmed, lowercased email,
 * returned as hex. Used wherever Bevel needs a stable email-derived identifier
 * without storing the raw email — PR author-id markers, self-approval
 * detection, etc. All callers MUST use this single function; a drift in the
 * normalization (case, whitespace) would silently de-attribute every PR the
 * bot opens because the hash embedded in the PR body would no longer match
 * the hash computed at lookup time.
 */
export function hashEmail(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}
