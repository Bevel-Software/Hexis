import { GROUPS_DIR, isJoinBranchFor, type ChangeRequest } from '@bevel-software/platform-shared';
import type { JoinRequestRow } from '../components/AccessRequestsBanner';

/**
 * The open join requests for one group, read off the change-request list the
 * Library already carries.
 *
 * TWO conditions, and the second is the load-bearing one:
 *
 *  1. the branch matches the join-branch convention, and
 *  2. the change request touches EXACTLY the group's `access.md` — nothing
 *     else, nothing more.
 *
 * Without (2) the branch name alone decides what the banner claims, and any
 * user can name a branch: draft branches are ungated, so somebody could push
 * arbitrary edits on a `…/join-<group>-<tag>` branch and have the banner
 * present it to an owner as "X asked to join" above an Approve button that
 * merges it. The merge gate still stops changes to files the approver cannot
 * write — but it cannot stop an approver from being MISLED about what they
 * are approving, and everything else in the group is a file they CAN write.
 * So the banner only dresses up a change request whose diff is exactly the
 * grant it promises; anything else stays an ordinary change request in the
 * normal review surfaces, where it is described honestly.
 *
 * A change request whose touched paths could not be computed (an empty list —
 * no workspace yet, or a git hiccup) is therefore skipped rather than
 * assumed benign. Fail-closed: the request is still visible and mergeable in
 * the change-request list; it just doesn't get the one-click banner.
 *
 * Callers gate the RENDER on `summary.canWrite` — every member can see the
 * change requests, but only the people who can act on a request get its
 * banner.
 */
export function joinRequestsFor(crs: ChangeRequest[], group: string): JoinRequestRow[] {
  const accessMd = `${GROUPS_DIR}/${group}/access.md`;
  return crs
    .filter(
      (cr) =>
        cr.state === 'open' &&
        isJoinBranchFor(cr.branch, group) &&
        cr.touchedNodePaths.length === 1 &&
        cr.touchedNodePaths[0] === accessMd,
    )
    .map((cr) => ({ number: cr.number, requesterName: cr.appAuthor?.name ?? 'Someone' }));
}
