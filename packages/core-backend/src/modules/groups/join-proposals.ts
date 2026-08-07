import {
  KNOWN_VERBS,
  parseAccessFile,
  type ParsedEntry,
  type Verb,
} from '../access/access-control.service.js';

/**
 * What a join branch is PROPOSING, relative to the default branch.
 *
 * A join request is a change request whose branch edits one group's
 * `access.md`. Rather than treating that change request as an all-or-nothing
 * merge, the group's managers see its individual proposals — "grant Ali read",
 * "grant GTM Team write" — and answer them one at a time. Approving a proposal
 * writes THAT ONE grant onto the default branch through the ordinary access
 * mutation path; the branch is never merged, so nothing else it happens to
 * contain can ride along, and a change request naming five people can be
 * answered with two yeses and three ignores.
 *
 * A proposal is any (principal, verb) GRANT the branch's copy of the file
 * carries that the default branch's copy does not. Deliberately:
 *
 *  - grants only. A `deny` entry is not something to "accept", and a branch
 *    that REMOVES an existing grant proposes nothing — it is a revocation,
 *    which is not what this surface is for. Both are simply invisible here,
 *    and both leave the branch as a normal change request in the review UI.
 *  - every verb, not just `read`. A branch asking for `write` must be visible
 *    AS a write request rather than hiding behind "asked to join"; and the
 *    subset test that retires a request has to cover everything the file can
 *    express, or a request proposing `write` would never settle.
 *
 * When the list comes back EMPTY the branch adds nothing the default branch
 * does not already grant — its proposals have all been accepted (or were
 * never anything) — and the change request has no reason to stay open.
 */
export interface JoinProposal {
  verb: Verb;
  /** Canonical identity — lowercased email, or canonical role name. */
  id: string;
  principal:
    | { kind: 'user'; email: string; displayName: string }
    | { kind: 'role'; role: string };
  /** How to name this principal in the UI. */
  label: string;
}

/** Canonical identity of an entry, for set comparison across the two files. */
function identityOf(entry: ParsedEntry): string {
  return entry.kind === 'user' ? `user:${entry.email}` : `role:${entry.role}`;
}

/**
 * Folder rules from one copy of an `access.md`, per verb, grants only.
 *
 * A file that fails to parse yields NO grants. On the branch side that means
 * a malformed proposal offers nothing to accept (fail-closed). On the default
 * side it means every branch grant looks incoming — which is the safe
 * direction too: the manager is shown proposals to consider rather than
 * having them silently swallowed by an unreadable baseline.
 */
function grantsByVerb(text: string | null, path: string): Map<Verb, Map<string, ParsedEntry>> {
  const out = new Map<Verb, Map<string, ParsedEntry>>();
  for (const verb of KNOWN_VERBS) out.set(verb, new Map());
  if (text === null) return out;
  const parsed = parseAccessFile(text, path);
  if (!parsed.ok) return out;
  for (const verb of KNOWN_VERBS) {
    const byId = out.get(verb)!;
    for (const entry of parsed.file.entries[verb]) {
      if (entry.deny) continue;
      byId.set(identityOf(entry), entry);
    }
  }
  return out;
}

/**
 * The grants `branchText` adds over `defaultText` — the proposals a manager
 * can accept. Empty ⇒ the branch's rules are a subset of the default's.
 *
 * `path` is only used to label parse errors; both texts are the same file at
 * two refs.
 */
export function pendingProposals(
  branchText: string | null,
  defaultText: string | null,
  path: string,
): JoinProposal[] {
  const branch = grantsByVerb(branchText, path);
  const base = grantsByVerb(defaultText, path);
  const out: JoinProposal[] = [];
  for (const verb of KNOWN_VERBS) {
    const baseIds = base.get(verb)!;
    for (const [id, entry] of branch.get(verb)!) {
      if (baseIds.has(id)) continue;
      out.push(
        entry.kind === 'user'
          ? {
              verb,
              id,
              principal: { kind: 'user', email: entry.email, displayName: entry.displayName },
              label: entry.displayName,
            }
          : {
              verb,
              id,
              principal: { kind: 'role', role: entry.displayRole },
              label: entry.displayRole,
            },
      );
    }
  }
  return out;
}
