import type { PullRequestDetail } from '@bevel-software/platform-shared';

/**
 * A person's name as the finished view may show it, or null: a blank name and
 * one shaped like an email address (an account that never set a name) are no
 * name. The one rule for every person on a finished request — the applier
 * (`applierName`), the author and the approvers.
 */
export function displayName(name: string | null | undefined): string | null {
  const trimmed = name?.trim() ?? '';
  return !trimmed || /\S+@\S+/.test(trimmed) ? null : trimmed;
}

function nameOnly(name: string | undefined): string {
  return displayName(name) ?? '';
}

/**
 * A FINISHED change request's detail as the app's detail route serves it:
 * no email address of any PERSON on the record.
 *
 * The finished view names the applier by display name only, and an applied
 * request's approvals are where the applier's address otherwise travels: the
 * usual apply records the applier's own approval on every file first, so
 * `approvals[].approvedBy[].email` IS the applier's address, sent to every
 * caller. Nothing reads an address off a finished request — there is no
 * approval left to give or undo (the one thing `approvedBy[].email` is
 * compared for) — so every person goes by name alone: approvers, eligible
 * approvers and the author (`author.name` and `appAuthor.name` alike), with a
 * name that is itself an address (a user who never set one) blanked by
 * {@link displayName}, the rule `applierName` applies to the applier. Comments
 * go entirely: the finished view shows none, and a comment's body is free
 * text an address can sit in.
 *
 * What stays as written is the author's OWN text, the title and the
 * description: the finished view shows them as the open view does, and an
 * address the author typed into their proposal is theirs to have published,
 * not a person's identity the record leaks.
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
    author: { ...detail.author, name: nameOnly(detail.author.name) },
    ...(detail.appAuthor && { appAuthor: { name: nameOnly(detail.appAuthor.name) } }),
    approvals: detail.approvals.map((a) => ({
      ...a,
      eligibleApprovers: {
        ...a.eligibleApprovers,
        users: a.eligibleApprovers.users.map((u) => ({ ...u, email: '', name: nameOnly(u.name) })),
      },
      approvedBy: a.approvedBy.map((entry) => ({ ...entry, email: '', name: nameOnly(entry.name) })),
    })),
    comments: [],
  };
}
