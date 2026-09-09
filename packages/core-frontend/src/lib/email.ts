/**
 * ONE email-validation rule for every access/admin surface (Manage Access,
 * Roles & Members, Groups). Mirrors the backend's `EMAIL_REGEX`
 * (access-control.service.ts): no whitespace, no `<`/`>` (angle-bracket
 * forms like `Name <a@b.c>` are a different grammar), and exactly one `@`.
 *
 * Three per-surface copies existed and had already drifted (`<`/`>` slipped
 * through two of them) — a value the client accepts and the server refuses is
 * a round trip wasted on an error the input could have caught.
 */
export const EMAIL_RE = /^[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+$/;

/**
 * The roles.yaml grammar prefix for a group REFERENCE (`group:<name>`) —
 * never a member email. The backend refuses `group:`-prefixed member values
 * (a `group:lee@x.io` would pass the email regex and land a dead ref);
 * member inputs mirror that refusal with an inline hint instead of a round
 * trip.
 */
export const GROUP_MEMBER_PREFIX = 'group:';

/** True when a typed member value is a `group:` reference, not an email. */
export function isGroupPrefixed(value: string): boolean {
  return value.trim().toLowerCase().startsWith(GROUP_MEMBER_PREFIX);
}

/**
 * Avatar letters for a person, from their email or display name: two initials
 * when the local part looks like `first.last`, otherwise the first two
 * characters. Lives beside the email rule because every caller is an
 * email-keyed people surface.
 */
export function initials(value: string): string {
  const cleaned = value.trim();
  if (!cleaned) return '?';
  const [name] = cleaned.split('@');
  const parts = name.split(/[.\s_-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}
