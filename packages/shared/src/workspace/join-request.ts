/**
 * The join-request naming convention — how "asking to join a group" rides on
 * plain change requests with zero new backend state.
 *
 * A join request IS a change request: a draft branch carrying one commit that
 * adds the requester to the group's `access.md` body `read:` list, opened
 * against the default branch. What makes it recognisable — to the `Requested`
 * chip, to the owner-side banner, to idempotency — is only this branch-name
 * convention. Both sides (backend route, frontend banners) read it from here
 * so they can never drift.
 *
 *   <email-localpart>/join-<group-kebab>
 *
 * follows the workspace's existing `<email-localpart>/<kebab-slug>` draft
 * convention, so join branches sort with the requester's other drafts and
 * the branch-authorship delete rule applies unchanged.
 */

/** Group name → the kebab slug used in the join branch (lossy by design). */
export function kebabGroupName(group: string): string {
  return group
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/** The deterministic join branch for (requester, group). */
export function joinBranchFor(email: string, group: string): string {
  const localpart = email.toLowerCase().split('@')[0] ?? email.toLowerCase();
  return `${localpart}/join-${kebabGroupName(group)}`;
}

/**
 * Does `branch` look like SOMEBODY's join branch for `group`? Used by the
 * owner-side banner to bucket open CRs per group. The requester's identity
 * comes from the CR's own attribution (`appAuthor` / `authorId`), never from
 * the branch name.
 */
export function isJoinBranchFor(branch: string, group: string): boolean {
  const slug = kebabGroupName(group);
  if (!slug) return false;
  return new RegExp(`^[^/]+/join-${escapeRegExp(slug)}$`).test(branch);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
