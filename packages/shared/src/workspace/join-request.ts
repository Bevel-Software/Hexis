/**
 * The join-request naming convention — how "asking to join a group" rides on
 * plain change requests with zero new backend state.
 *
 * A join request IS a change request: a draft branch carrying one commit that
 * adds the requester to the group's `access.md` body `read:` list, opened
 * against the default branch. What makes it recognisable — to the `Requested`
 * chip, to the manager-side proposals surface, to idempotency — is only this
 * branch-name convention. Both sides (backend, frontend) read it from here so
 * they can never drift.
 *
 *   <email-localpart>/join-<group-kebab>-<groupTag>-<requesterTag>
 *
 * follows the workspace's existing `<email-localpart>/<kebab-slug>` draft
 * convention, so join branches sort with the requester's other drafts and
 * the branch-authorship delete rule applies unchanged.
 *
 * WHY TWO TAGS: the localpart and the kebab slug are both LOSSY, and each
 * loss has its own failure:
 *
 *  - `groupTag` — over the EXACT group name, recomputable by anyone who
 *    knows the group. `Finance!` and `finance` share the slug `finance`;
 *    without this tag, listing one group's requests would match the other's
 *    branches, read the wrong `access.md` (unchanged on that branch), see an
 *    empty diff and SETTLE the request — closing a change request and
 *    deleting a branch that belong to a different group. The settle decision
 *    is "the diff is empty", so group identity must be exact BEFORE the diff
 *    is consulted, and `isJoinBranchFor` recomputes this tag to make it so.
 *  - `requesterTag` — over the full email (+ group), NOT recomputable by a
 *    reader (a manager listing requests does not know each requester's
 *    email; `isJoinBranchFor` matches its shape only). It exists so
 *    `ali@bevel.software` and `ali@other.com` never share a branch — else
 *    the second requester's commit lands on the first one's branch.
 *
 * The tags are collision-avoidance devices, not a security boundary —
 * nothing grants access based on a branch name. Grants happen through the
 * ordinary access mutation path, and settling only ever closes a request
 * whose file adds nothing over the default branch.
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

/** Length of each branch-name tag, in base-36 characters. */
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

/** The exact-group tag — recomputable from the group name alone. */
function groupTag(group: string): string {
  return shortTag(`g:${group}`);
}

/** The deterministic join branch for (requester, group). */
export function joinBranchFor(email: string, group: string): string {
  const normalizedEmail = email.trim().toLowerCase();
  const localpart = normalizedEmail.split('@')[0] || normalizedEmail;
  const slug = kebabGroupName(group);
  const requester = shortTag(`u:${normalizedEmail}\n${group}`);
  // A group whose name has no alphanumerics at all (`!!!`) kebabs to '' — the
  // tags alone still yield a valid, matchable branch.
  const middle = slug ? `${slug}-` : '';
  return `${localpart}/join-${middle}${groupTag(group)}-${requester}`;
}

/**
 * Does `branch` look like SOMEBODY's join branch for EXACTLY `group`?
 *
 * The group half (slug + `groupTag`) is recomputed and must match — this is
 * what keeps slug-colliding groups (`Finance!` vs `finance`) from seeing,
 * and worse settling, each other's requests. The requester half cannot be
 * recomputed (the reader has no email) and matches by shape; the requester's
 * identity comes from the change request's own attribution.
 */
export function isJoinBranchFor(branch: string, group: string): boolean {
  const slug = kebabGroupName(group);
  const middle = slug ? `${escapeRegExp(slug)}-` : '';
  const requester = `[0-9a-z]{${TAG_LENGTH}}`;
  return new RegExp(`^[^/]+/join-${middle}${groupTag(group)}-${requester}$`).test(branch);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
