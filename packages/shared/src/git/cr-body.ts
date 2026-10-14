/**
 * The heading of the block Hexis appends to a change request's body: who may
 * approve each changed path. It is always appended LAST.
 */
export const AFFECTED_OWNERS_HEADING = '## Affected owners';

/**
 * A change request's body without the generated `## Affected owners` block —
 * the one rule for where the author's text ends, shared by the app's quote
 * and the agent tools' description so the two can never disagree.
 *
 * The body is cut at the LAST line that is the heading (trailing whitespace
 * ignored): the block is appended last, so every `##` heading the author wrote
 * stays. An author who writes that exact heading themselves loses their text
 * from there — the safe direction, and the only way this can err. HTML
 * comments are left to the caller, whose policies differ.
 */
export function withoutAffectedOwners(body: string): string {
  const lines = body.split('\n');
  const generated = lines.map((l) => l.trimEnd()).lastIndexOf(AFFECTED_OWNERS_HEADING);
  return (generated === -1 ? lines : lines.slice(0, generated)).join('\n');
}
