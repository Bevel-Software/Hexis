/**
 * The join-request naming convention — how "asking to join a group" rides on
 * plain change requests with zero new backend state.
 *
 * A join request IS a change request: a draft branch carrying one commit that
 * adds the requester to the group's `access.md` body `read:` list, opened
 * against the default branch. What makes it recognisable — to the `Requested`
 * chip, to the owner-side banner, to idempotency — is this branch-name
 * convention. Both sides (backend route, frontend banners) read it from here
 * so they can never drift.
 *
 *   <email-localpart>/join-<group-kebab>-<tag>
 *
 * follows the workspace's existing `<email-localpart>/<kebab-slug>` draft
 * convention, so join branches sort with the requester's other drafts and the
 * branch-authorship delete rule applies unchanged.
 *
 * WHY THE TAG: the localpart and the kebab slug are both LOSSY. Without it,
 * `ali@bevel.software` and `ali@other.com` share one branch (a second
 * requester's commit lands on the first one's branch, so merging the first
 * request silently admits both), and `Finance` and `Finance!` share one too
 * (the second request is answered with the first one's change request). The
 * tag is derived from the FULL email plus the EXACT group name, so distinct
 * requesters and case-/punctuation-distinct groups always get distinct
 * branches.
 *
 * The tag is a collision-avoidance device, not a security boundary — nothing
 * trusts a branch name. Approval is gated by the merge rule (an approver must
 * be able to write the touched `access.md`), and the owner-side banner
 * additionally verifies that a change request touches exactly that file
 * before it dresses one up as a join request.
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

/** Length of the branch-name disambiguator, in base-36 characters. */
const TAG_LENGTH = 7;

/**
 * Short deterministic tag over an exact string (FNV-1a, base36).
 *
 * Synchronous and dependency-free so the same value is derivable in the
 * browser and on the server; `crypto.subtle` is async and would force this
 * whole convention to become promise-shaped for no benefit. Not a hash in the
 * security sense and does not need to be — see the module note.
 */
function shortTag(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // FNV prime, via shifts so the whole thing stays in 32-bit int math.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(36).padStart(TAG_LENGTH, '0').slice(-TAG_LENGTH);
}

/** The deterministic join branch for (requester, group). */
export function joinBranchFor(email: string, group: string): string {
  const normalizedEmail = email.trim().toLowerCase();
  const localpart = normalizedEmail.split('@')[0] || normalizedEmail;
  const slug = kebabGroupName(group);
  const tag = shortTag(`${normalizedEmail}\n${group}`);
  // A group whose name has no alphanumerics at all (`!!!`) kebabs to '' — the
  // tag alone still yields a valid, matchable branch.
  return slug ? `${localpart}/join-${slug}-${tag}` : `${localpart}/join-${tag}`;
}

/**
 * Does `branch` look like SOMEBODY's join branch for `group`?
 *
 * The tag is deliberately NOT recomputed here: this predicate runs on other
 * people's branches (the owner-side banner shows every requester), and their
 * email is not in hand. It matches the SHAPE — which is why the banner pairs
 * it with a touched-path check rather than trusting the name alone. The
 * requester's identity comes from the change request's own attribution.
 */
export function isJoinBranchFor(branch: string, group: string): boolean {
  const slug = kebabGroupName(group);
  const tag = `[0-9a-z]{${TAG_LENGTH}}`;
  const suffix = slug ? `join-${escapeRegExp(slug)}-${tag}` : `join-${tag}`;
  return new RegExp(`^[^/]+/${suffix}$`).test(branch);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
