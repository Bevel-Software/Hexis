/**
 * How long a tool description may be, and how to measure one.
 *
 * Clients cut a long description, and they cut it from the END — which is
 * where the text specific to the tool sits, after whatever shared preamble it
 * carried. Agents reported `file_stat`, `read_file`, `write_file` and
 * `write_files` arriving ending in "[truncated]". The rules those descriptions
 * shared now live in one place (see `agent-instructions/shared-file-rules.ts`,
 * served in the guide `get_agent_guide` returns) and each description OPENS
 * with the one sentence sending the agent there (`guide-first.ts`), which is
 * what makes the cap below reachable rather than aspirational.
 */

import { callLine, splitCallLine } from '@bevel-software/platform-mcp-core';
import { TOOL_PREFIX_CAP } from '@bevel-software/platform-shared';
import { PREFIXED_TOOLS } from '../agent-instructions/compose.js';
import { EXTERNAL_KB_MANUAL_NAME } from '../tool-manuals/tool-manuals.contract.js';
import { GUIDE_FIRST_SENTENCE } from './guide-first.js';
import type { UtcpTool } from './tool.contract.js';

/**
 * The ceiling on what a client is handed for one tool, enforced by
 * `__tests__/tool-description-length.test.ts`.
 *
 * DERIVED, not published: the clients that cut descriptions do not say where.
 * Two cuts were observed, and they are different problems. claude.ai cuts
 * around 500 characters — NOT what this cap answers, and not something a cap
 * could answer: no useful description of `move_file` fits in 500. What answers
 * that one is the ORDER of the text, which is why the deployment's purpose line
 * is prepended rather than appended (see `prefixToolDescription`) and why every
 * description now opens with the guide-first sentence and then what the tool
 * does, with the tool's own detail last: a cut at 500 keeps the sentence and
 * the tool's first sentence (see `firstSentenceEnd`) and takes the detail,
 * which the guide states in full anyway. The other cut is the
 * four-figure one agents reported on `file_stat`, `read_file`, `write_file` and
 * `write_files`, and 1,200 sits below it with room to spare.
 *
 * So the cap is a ceiling on growth rather than a guarantee of survival, and it
 * is a number the reviewer may move: the point of pinning it is that moving it
 * is a decision someone takes, rather than a paragraph someone appends.
 */
export const TOOL_DESCRIPTION_CAP = 1_200;

/**
 * The OTHER cut — the ~500 characters claude.ai allows — as a number the tests
 * can hold something to.
 *
 * It is deliberately not the value of {@link TOOL_DESCRIPTION_CAP}, and the
 * difference is the whole point: lowering the cap to 500 would not make these
 * descriptions survive that client, it would only move the loss from the client
 * to the source, because no useful description of `move_file` or `file_stat`
 * fits in 500 characters and shortening them to fit means dropping facts an
 * agent needs.
 *
 * What survives a cut here is decided by ORDER instead, and order is testable:
 * the purpose prefix goes first, the tool's own opening sentence next, the
 * pointer to the shared rules last. So a cut at 500 takes the pointer — which
 * costs the agent the name of a file the handshake instructions and the guide
 * both state anyway — and leaves the sentence saying what the tool does.
 * {@link firstSentenceEnd} measures where that sentence ends, and the suite
 * pins it under this number for every tool, so the claim above is a check
 * rather than a comment.
 */
export const CLIENT_SHORT_CUT = 500;

/** What these measurements read of a tool: its name, its text and the schema its `Call:` line is generated from. */
export type MeasuredTool = Pick<UtcpTool, 'name' | 'description'> & { inputs?: unknown };

/**
 * The `Call:` line a client is handed ahead of everything else, and the blank
 * line after it — counted, because it is part of what a client cuts. Taken
 * from the description when it already opens with one (a meta-tool is built
 * with its line), generated from the tool's inputs under the namespace the
 * hosted endpoint serves otherwise, as mcp-core's `withCallExample` does at
 * listing time. The rest of the description comes back beside it.
 */
function splitServedCallLine(tool: MeasuredTool): { callChars: number; rest: string } {
  const { call, rest } = splitCallLine(tool.description ?? '');
  const line = call ?? callLine(`${EXTERNAL_KB_MANUAL_NAME}.${tool.name}`, tool.inputs);
  // The blank line after it only when something follows it.
  const followed = rest !== '' || PREFIXED_TOOLS.has(tool.name);
  return { callChars: line.length + (followed ? 2 : 0), rest };
}

/**
 * Where the tool's OWN opening sentence ends in the text a client is handed:
 * the purpose prefix counted at its cap, as in {@link clientVisibleLength},
 * and the guide-first sentence every listed tool opens with counted as the
 * text it is — a client that cuts at 500 must still reach the sentence saying
 * what the tool does, past that one.
 *
 * A description with no sentence-ending punctuation counts whole — the honest
 * answer for text that never finishes a sentence.
 */
export function firstSentenceEnd(tool: MeasuredTool): number {
  const { callChars, rest: description } = splitServedCallLine(tool);
  const prefix = callChars + (PREFIXED_TOOLS.has(tool.name) ? TOOL_PREFIX_CAP + 2 : 0);
  if (description === '') return prefix;
  // The opener and whatever whitespace follows it: `guideFirstDescription`
  // joins with one space, and leaves a description that already opens with
  // the sentence as it came — a newline after it is still the opener's.
  const opener = description.startsWith(GUIDE_FIRST_SENTENCE)
    ? GUIDE_FIRST_SENTENCE.length + (description.slice(GUIDE_FIRST_SENTENCE.length).match(/^\s*/)?.[0].length ?? 0)
    : 0;
  const own = description.slice(opener);
  const firstSentence = own.match(/^[\s\S]*?[.!?](?=\s|$)/)?.[0] ?? own;
  return prefix + opener + firstSentence.length;
}

/**
 * The length of the description as a CLIENT receives it — which for the four
 * knowledge-base tools includes the deployment's purpose prefix, since the MCP
 * surface prepends it (`prefixToolDescription`) and the client cuts the result.
 * Measured at the prefix's CAP rather than at whatever the current admin wrote:
 * the cap is what an admin may grow their text to without being told, so a
 * description that only fits beside a short prefix does not really fit.
 *
 * The guide-first sentence every listed tool opens with is already in the
 * description the registry lists, so it is measured as the text it is.
 */
export function clientVisibleLength(tool: MeasuredTool): number {
  const { callChars, rest } = splitServedCallLine(tool);
  return callChars + ownVisibleLength(tool.name, rest);
}

/** {@link clientVisibleLength} without the `Call:` line: the purpose prefix and the tool's own text. */
function ownVisibleLength(name: string, description: string): number {
  const own = description.length;
  // A prefixed tool with no description of its own is still handed the prefix,
  // and nothing else — `prefixToolDescription` sends the prefix alone, with no
  // blank line after it. Measuring that as zero would under-report the only
  // text the client got.
  if (own === 0) return PREFIXED_TOOLS.has(name) ? TOOL_PREFIX_CAP : 0;
  // `+ 2` for the blank line `prefixToolDescription` puts between the two.
  return PREFIXED_TOOLS.has(name) ? own + TOOL_PREFIX_CAP + 2 : own;
}
