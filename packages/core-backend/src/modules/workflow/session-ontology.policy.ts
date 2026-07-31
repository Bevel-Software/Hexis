/**
 * Ontology-session boundary — the PURE decision core (no IO, no DB).
 *
 * Model: each run/session accumulates the SET of named ontologies it has
 * touched (via any read or write). The rule is asymmetric:
 *
 *   READS  — always allowed. A read that touches a named ontology RECORDS it
 *            into the session's touched set (so it can poison later writes).
 *   WRITES — allowed only while the session is confined to a SINGLE named
 *            ontology and the write targets that same ontology. The moment a
 *            session has touched two or more named ontologies (typically by
 *            reading across them), EVERY subsequent write is blocked — "read
 *            across ontologies → you can't write anymore at all."
 *
 * Neutral touches (`ontologyOf` → null: root config, Skills, root-level
 * Knowledge, non-KB) never record and never block. See
 * `docs/rp4-ontology-boundary-plan-v2.md`.
 *
 * `SessionOntologyService` (Postgres-backed) persists the touched set and calls
 * these helpers; this module keeps the rule itself testable in isolation.
 */

import type { Ontology } from '@bevel-software/shared';

/** Outcome of a write check against the session's touched-ontology set. */
export type WriteDecision =
  | { allow: true }
  | { allow: false; reason: 'multi-ontology' | 'different-ontology'; touched: string[]; attempted: string };

/**
 * The set of NAMED ontologies a session has touched after this operation. A
 * neutral operation (`ontology === null`) adds nothing. Pure — returns a new
 * set, never mutates the input.
 */
export function recordTouch(touched: ReadonlySet<string>, ontology: Ontology): Set<string> {
  const next = new Set(touched);
  if (ontology !== null) next.add(ontology);
  return next;
}

/**
 * Decide whether a WRITE to `attempted` is allowed given the ontologies the
 * session has already touched (NOT counting this write yet).
 *
 *   - A write to a neutral path (`attempted === null`) is always allowed.
 *   - If the session has already touched two or more named ontologies, the
 *     write is blocked (`multi-ontology`) — reading across ontologies poisoned
 *     the session's write ability.
 *   - If the session has touched exactly one named ontology and it differs from
 *     the write target, the write is blocked (`different-ontology`).
 *   - If the session is unpinned (touched none) or its single touched ontology
 *     equals the target, the write is allowed.
 */
export function decideWrite(touched: ReadonlySet<string>, attempted: Ontology): WriteDecision {
  if (attempted === null) return { allow: true };

  // The set of named ontologies the session would span if this write lands.
  const spanned = new Set(touched);
  spanned.add(attempted);

  if (spanned.size <= 1) return { allow: true };

  // spanned.size >= 2 — the write would put the session across a boundary.
  const touchedList = [...touched].sort();
  if (touched.size >= 2) {
    return { allow: false, reason: 'multi-ontology', touched: touchedList, attempted };
  }
  // Exactly one prior ontology, and it isn't the write target.
  return { allow: false, reason: 'different-ontology', touched: touchedList, attempted };
}
