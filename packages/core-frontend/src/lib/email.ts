/**
 * ONE email-validation rule for every access/admin surface (Manage Access,
 * App roles, Groups). Mirrors the backend's `EMAIL_REGEX`
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
 * Avatar letters for a person, from their email, display name or a
 * `Name <email>` label: two initials when the name (or the email's local
 * part) has two words, otherwise its first two characters. THE one
 * monogram rule — the same person must get the same letters on every
 * people surface (App roles, Groups & Members, Manage access), so no
 * surface keeps a local copy.
 */
export function initials(value: string): string {
  const label = value.trim();
  // `Name <email>`: the name is the person, the address only stands in when
  // the label carries nothing else — never a second word beside a one-word name.
  const angled = label.match(/^(.*?)\s*<([^<>]*)>$/);
  const displayName = angled?.[1].trim() ?? '';
  const cleaned = angled ? displayName || angled[2].trim() : label;
  if (!cleaned) return '?';
  // Only an ADDRESS is cut at `@`: a display name is taken whole, whatever
  // characters it carries.
  return labelInitials(displayName ? cleaned : cleaned.split('@')[0]);
}

/**
 * Avatar letters for a LABEL that is not a person — a group, a role, a
 * plugin: two initials from its first two words (split on whitespace,
 * dots, dashes, underscores), else its first two characters. No address
 * parsing: an `@` in a group name is just a character. `initials` ends
 * here too, once it has decided which part of a person's label is the name.
 */
export function labelInitials(label: string): string {
  const cleaned = label.trim();
  if (!cleaned) return '?';
  const parts = cleaned.split(/[.\s_-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return cleaned.slice(0, 2).toUpperCase();
}
