/**
 * The name of a person's own space — the prototype's `MINE()` (line 2078),
 * which reads `me().name.split(' ')[0] + "'s List"`.
 *
 * It is called a GROUP here rather than a list because that is what it now is:
 * the same page, the same sections, the same card grid as `Groups/Engineering`.
 * The only difference is which items it holds, and that is a query, not a kind.
 *
 * First name only, deliberately. "Juan's Group" is what a colleague would call
 * it out loud; "Juan Viera's Group" is what a directory would call it.
 */
export function personalGroupName(displayName: string | null | undefined): string {
  const first = (displayName ?? '').trim().split(/\s+/)[0] ?? '';
  // Nobody signed in, or a user record with no name: the space still exists and
  // still needs a heading, and "Yours" is true for whoever is reading it.
  if (!first) return 'Yours';
  return `${first.charAt(0).toUpperCase()}${first.slice(1)}'s Group`;
}
