import type { PullRequestDetail } from '@bevel-software/platform-shared';

/**
 * A FINISHED change request's detail as the app's detail route serves it: no
 * email address anywhere in it.
 *
 * The finished view names the applier by display name only, and an applied
 * request's approvals are where the applier's address otherwise travels: the
 * usual apply records the applier's own approval on every file first, so
 * `approvals[].approvedBy[].email` IS the applier's address, sent to every
 * caller. Nothing reads an address off a finished request — there is no
 * approval left to give or undo (the one thing `approvedBy[].email` is
 * compared for), and the view shows neither approvers nor comments — so every
 * address goes: approvers, eligible approvers and comment authors alike.
 *
 * An OPEN request is returned untouched: its review controls compare the
 * viewer's own address with these to offer Undo.
 *
 * Applied at the HTTP route, not in `getPrDetail`: the agent read tools build
 * reviewer logins from these addresses and keep their own shape.
 */
export function withoutAddresses(detail: PullRequestDetail): PullRequestDetail {
  if (detail.state === 'open') return detail;
  return {
    ...detail,
    approvals: detail.approvals.map((a) => ({
      ...a,
      eligibleApprovers: {
        ...a.eligibleApprovers,
        users: a.eligibleApprovers.users.map((u) => ({ ...u, email: '' })),
      },
      approvedBy: a.approvedBy.map((entry) => ({ ...entry, email: '' })),
    })),
    comments: detail.comments.map((c) => ({ ...c, author: { ...c.author, email: '' } })),
  };
}
