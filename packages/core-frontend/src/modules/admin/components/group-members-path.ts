/**
 * The Groups & Members page, opened on ONE group — the link the Library
 * sidebar's "Manage members" follows.
 *
 * The group rides in the query string rather than in component state so the
 * link can be shared and survives a reload: whoever opens it lands on the same
 * card. It names the group as the sidebar does (its display name); the page
 * also accepts the canonical name, and matches either without regard to case.
 *
 * Here rather than in `DirectoryGroupsPage`, because a component file that
 * also exports a plain function breaks fast refresh for the whole module.
 */
export const GROUP_MEMBERS_PATH = '/directory-groups';
export const GROUP_PARAM = 'group';

export function pathForGroupMembers(group: string): string {
  return `${GROUP_MEMBERS_PATH}?${new URLSearchParams({ [GROUP_PARAM]: group })}`;
}

/** Whether a roster entry is the one a `?group=` value names. */
export function isNamedGroup(
  entry: { canonical: string; displayName: string },
  name: string | null,
): boolean {
  if (!name) return false;
  // As the backend canonicalises a group name: case and inner whitespace
  // are not identity, so a link typed or shared with two spaces still lands
  // on the card.
  const fold = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
  const wanted = fold(name);
  return fold(entry.displayName) === wanted || fold(entry.canonical) === wanted;
}
