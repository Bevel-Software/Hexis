/**
 * The access verbs and the ONE dependency graph between them.
 *
 * Shared so that everything that folds verbs — the resolver in core-backend,
 * the eligible lists it serves, and the share dialog in core-frontend that
 * renders and edits them — reads the same table. A second fold written out by
 * hand somewhere else is how the sheet comes to show "Owner" for someone the
 * resolver refuses, or writes a `read:` line under an `owner:` it just granted.
 *
 * `read` controls who may VIEW a path. It is default-deny: a path with no
 * effective grant of any verb is not readable. `write` is editing (and, with
 * it, approval rights), `download` is saving a copy, `owner` is the contact
 * point for the node and the right to manage its access.
 */

/**
 * Verbs an `access.md` frontmatter can grant, each a list of principals
 * optionally prefixed with `deny `. `AccessFile.entries` in the backend is
 * statically keyed on this union; keep `Verb` and `KNOWN_VERBS` in lockstep.
 */
export const KNOWN_VERBS = ['read', 'write', 'download', 'owner'] as const;
export type Verb = (typeof KNOWN_VERBS)[number];

/**
 * THE DEPENDENCY GRAPH — what holding each verb presupposes, declared once.
 * `owner` presupposes `write` and `download`; `write` and `download` each
 * presuppose `read`; `read` presupposes nothing. Everything about how verbs
 * fold into one another is DERIVED from this table, in both directions:
 *
 *   - a GRANT confers, downwards, every verb the granted one presupposes
 *     (`sourceVerbsFor`, `effectiveVerbs`): an owner may edit, save and open;
 *     an editor may open; someone trusted with a copy may open it;
 *   - a DENIAL strips, upwards, every verb that presupposes the denied one
 *     (`requiredVerbsFor`): nobody owns what they may not edit, and nobody
 *     edits or saves what they may not open.
 *
 * Neither converse is implied: a `deny write` says nothing about `read`, and a
 * `read` grant confers no `write`. `write` and `download` are independent of
 * each other. Add a verb, or change what one presupposes, HERE and nowhere
 * else; every list and fold below follows.
 */
export const VERB_REQUIRES: Readonly<Record<Verb, readonly Verb[]>> = {
  read: [],
  write: ['read'],
  download: ['read'],
  owner: ['write', 'download'],
};

/** `verb` and everything it presupposes, transitively. */
function presupposedBy(verb: Verb): ReadonlySet<Verb> {
  const out = new Set<Verb>();
  const visit = (v: Verb) => {
    if (out.has(v)) return;
    out.add(v);
    for (const dep of VERB_REQUIRES[v]) visit(dep);
  };
  visit(verb);
  return out;
}

/**
 * Verbs whose GRANT confers `verb`, target verb first: `verb` itself, then
 * every verb that presupposes it, in `KNOWN_VERBS` order.
 */
export function sourceVerbsFor(verb: Verb): Verb[] {
  return [verb, ...KNOWN_VERBS.filter((v) => v !== verb && presupposedBy(v).has(verb))];
}

/**
 * Verbs whose DENIAL strips `verb`, target verb first: `verb` itself, then
 * every verb it presupposes, in `KNOWN_VERBS` order.
 */
export function requiredVerbsFor(verb: Verb): Verb[] {
  const needs = presupposedBy(verb);
  return [verb, ...KNOWN_VERBS.filter((v) => v !== verb && needs.has(v))];
}

/**
 * The verbs in the order a change to a principal's set has to be APPLIED:
 * broadest first, so every verb comes before the verbs it presupposes (ties in
 * `KNOWN_VERBS` order). Lowering must start at the top — denying `write` while
 * an `owner:` grant still stands in the same file is refused as ineffective,
 * since owner confers write; stripping owner first removes what was conferring
 * it. Raising reads the same order for the opposite reason: granting `owner`
 * first satisfies the rest in one line.
 */
export const VERBS_BROADEST_FIRST: readonly Verb[] = [...KNOWN_VERBS].sort(
  (a, b) =>
    presupposedBy(b).size - presupposedBy(a).size || KNOWN_VERBS.indexOf(a) - KNOWN_VERBS.indexOf(b),
);

/** One flag per verb: what a principal holds, or what a form has ticked. */
export type VerbSet = Record<Verb, boolean>;
/** A partial set — flags left out read as not held. */
export type VerbFlags = Partial<Record<Verb, boolean>>;

/**
 * The grant fold, as a whole set: what a principal EFFECTIVELY holds given the
 * verbs they are granted. Each verb is held when it, or any verb that
 * presupposes it, is in `held`. Idempotent on an already-folded set.
 */
export function effectiveVerbs(held: VerbFlags): VerbSet {
  const out = {} as VerbSet;
  for (const verb of KNOWN_VERBS) out[verb] = sourceVerbsFor(verb).some((w) => held[w] === true);
  return out;
}

/**
 * True when some OTHER verb in `held` confers `verb` — it is implied, not
 * chosen, which is what a form renders as checked-and-disabled.
 */
export function conferredByOthers(held: VerbFlags, verb: Verb): boolean {
  return sourceVerbsFor(verb).some((w) => w !== verb && held[w] === true);
}

/**
 * The fewest grant lines that produce `held`: every held verb that no other
 * held verb confers, broadest first. `{ owner }` is one line; `{ write, read,
 * download }` is `write` and `download` (read rides on either); `{ read,
 * download }` is `download` alone. A flag left out is not granted.
 */
export function minimalGrantVerbs(held: VerbFlags): Verb[] {
  return VERBS_BROADEST_FIRST.filter((verb) => held[verb] === true && !conferredByOthers(held, verb));
}
