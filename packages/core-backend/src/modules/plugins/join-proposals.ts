import {
  KNOWN_VERBS,
  ownAccessReadable,
  parseAccessFile,
  parseOwnAccessEntries,
  type ParsedEntry,
  type Verb,
} from '../access-model/access-grammar.js';
import type { TargetKind } from '../access/access-mutation.service.js';

/**
 * What a join branch is PROPOSING, relative to the default branch.
 *
 * A join request is a change request whose branch edits one plugin's
 * `access.md`. Rather than treating that change request as an all-or-nothing
 * merge, the plugin's managers see its individual proposals — "grant Ali read",
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
 * The per-verb entries one copy of an item's rules declares, or null when the
 * text could not be read as rules at all.
 *
 * THE GRAMMAR FOLLOWS THE ITEM, because there are two of them and the
 * resolver picks by item as well:
 *
 *   folder   a `access.md`, whose folder rules are a BODY of `verb:` block
 *            lists — `parseAccessFile`, which fails the whole file if a verb
 *            is not a list.
 *   file     the node's OWN frontmatter — `parseOwnAccessEntries`, which also
 *            accepts the single-value scalar form (`write: Rita <r@x.io>`),
 *            ignores non-access keys like `nodeType:`, and drops a bad entry
 *            rather than failing the file.
 *
 * Reading a file's frontmatter with the FOLDER grammar is what broke every
 * request whose target was a file: `spliceGrant` writes one grant into a
 * node's frontmatter as exactly that scalar — the same bytes the dialog's own
 * grant writes, which the resolver honours — and the folder grammar rejects it
 * with "'write:' must be a list", failing the parse, yielding no grants, which
 * reads as a branch with nothing left to propose. The request was then closed
 * on the editors' first listing, before anyone had seen it.
 *
 * Null is reserved for "could not be read": a folder `access.md` that does
 * not parse, or a file whose frontmatter is broken (never closed, or not a
 * mapping). A file with no frontmatter, or with frontmatter naming no verb,
 * is perfectly readable and simply grants nothing. The file grammar's own
 * null does not tell those apart, so the question is asked separately: a
 * broken block read as "grants nothing" would close the request on a
 * reading that failed, the same mistake by another door.
 */
function entriesOf(
  text: string,
  path: string,
  kind: TargetKind,
): Record<Verb, ParsedEntry[]> | null {
  if (kind === 'file') {
    return parseOwnAccessEntries(text) ?? (ownAccessReadable(text) ? emptyGrants() : null);
  }
  const parsed = parseAccessFile(text, path);
  return parsed.ok ? parsed.file.entries : null;
}

function emptyGrants(): Record<Verb, ParsedEntry[]> {
  const out = {} as Record<Verb, ParsedEntry[]>;
  for (const verb of KNOWN_VERBS) out[verb] = [];
  return out;
}

/** An index that grants nothing — the baseline a copy nobody could read stands in as. */
function emptyIndex(): Map<Verb, Map<string, ParsedEntry>> {
  return new Map(KNOWN_VERBS.map((verb) => [verb, new Map<string, ParsedEntry>()]));
}

/**
 * Grants only, indexed by canonical identity, from one copy of the rules.
 * Null in, null out — an unreadable copy is not an empty one.
 */
function grantsByVerb(
  text: string | null,
  path: string,
  kind: TargetKind,
): Map<Verb, Map<string, ParsedEntry>> | null {
  if (text === null) return null;
  const entries = entriesOf(text, path, kind);
  if (entries === null) return null;
  const out = emptyIndex();
  for (const verb of KNOWN_VERBS) {
    const byId = out.get(verb)!;
    for (const entry of entries[verb]) {
      if (entry.deny) continue;
      byId.set(identityOf(entry), entry);
    }
  }
  return out;
}

/**
 * The grants `branchText` adds over `defaultText` — the proposals an editor
 * can accept. Empty ⇒ the branch's rules are a subset of the default's, which
 * is the settled state.
 *
 * NULL when the branch's own copy is absent or unreadable, which is a
 * different fact entirely and the one this surface keeps getting wrong: an
 * empty answer closes somebody's request, so it has to mean "the branch asks
 * for nothing more", never "the branch would not tell us".
 *
 * An unreadable DEFAULT copy stays what it was — every branch grant looks
 * incoming. That is the safe direction on that side: an editor is shown
 * proposals to consider rather than having them swallowed by a baseline
 * nobody could read.
 *
 * `path` labels parse errors; both texts are the same file at two refs, and
 * `kind` says which grammar that file is written in.
 */
export function pendingProposals(
  branchText: string | null,
  defaultText: string | null,
  path: string,
  kind: TargetKind,
): JoinProposal[] | null {
  const branch = grantsByVerb(branchText, path, kind);
  if (branch === null) return null;
  const base = grantsByVerb(defaultText, path, kind) ?? emptyIndex();
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
