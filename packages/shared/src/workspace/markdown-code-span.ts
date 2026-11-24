/**
 * Quoting a name as Markdown inline code, whatever the name holds.
 *
 * Pure and dependency-free, so the agent instructions the backend writes and
 * the prompts the web app hands to an agent quote names by one rule.
 */

/**
 * `text` as one Markdown code span whatever it contains: a fence one backtick
 * longer than the longest run inside it, padded with a space where the text
 * starts or ends with a backtick (CommonMark strips one such space). A branch
 * name may hold a backtick, and a plain `` `name` `` would end the span early
 * and leave the rest of the sentence naming half a branch.
 */
export function markdownCodeSpan(text: string): string {
  const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longestRun + 1);
  const padded = text.startsWith('`') || text.endsWith('`') ? ` ${text} ` : text;
  return `${fence}${padded}${fence}`;
}
