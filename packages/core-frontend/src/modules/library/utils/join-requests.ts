import { isJoinBranchFor, type ChangeRequest } from '@bevel-software/platform-shared';
import type { JoinRequestRow } from '../components/AccessRequestsBanner';

/**
 * The open join requests for one group, read off the CR list the Library
 * already carries. A join request is recognised purely by the join-branch
 * convention (`<localpart>/join-<group-kebab>`); the requester's name comes
 * from the CR's own attribution, never from the branch.
 *
 * Callers gate the RENDER on `summary.canWrite` — every open CR is visible
 * to every member, but only the people who can act on a request should be
 * shown its banner.
 */
export function joinRequestsFor(crs: ChangeRequest[], group: string): JoinRequestRow[] {
  return crs
    .filter((cr) => cr.state === 'open' && isJoinBranchFor(cr.branch, group))
    .map((cr) => ({ number: cr.number, requesterName: cr.appAuthor?.name ?? 'Someone' }));
}
