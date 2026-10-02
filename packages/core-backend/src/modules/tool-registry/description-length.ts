/**
 * How long a tool description may be, and how to measure one.
 *
 * Clients cut a long description, and they cut it from the END — which is
 * where the text specific to the tool sits, after whatever shared preamble it
 * carried. Agents reported `file_stat`, `read_file`, `write_file` and
 * `write_files` arriving ending in "[truncated]". The rules those descriptions
 * shared now live in one place (see `agent-instructions/shared-file-rules.ts`)
 * and each description ends with one sentence pointing there, which is what
 * makes the cap below reachable rather than aspirational.
 */

import { TOOL_PREFIX_CAP } from '@bevel-software/platform-shared';
import { PREFIXED_TOOLS } from '../agent-instructions/compose.js';
import { SHARED_RULES_POINTER_MAX, sharedRulesPointer } from '../agent-instructions/shared-file-rules.js';
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
 * description now leads with what the tool does and ends with the pointer: a
 * cut at 500 then takes the pointer and leaves the tool. The other cut is the
 * four-figure one agents reported on `file_stat`, `read_file`, `write_file` and
 * `write_files`, and 1,200 sits below it with room to spare.
 *
 * So the cap is a ceiling on growth rather than a guarantee of survival, and it
 * is a number the reviewer may move: the point of pinning it is that moving it
 * is a decision someone takes, rather than a paragraph someone appends.
 */
export const TOOL_DESCRIPTION_CAP = 1_200;

/**
 * The length of the description as a CLIENT receives it — which for the four
 * knowledge-base tools includes the deployment's purpose prefix, since the MCP
 * surface prepends it (`prefixToolDescription`) and the client cuts the result.
 * Measured at the prefix's CAP rather than at whatever the current admin wrote:
 * the cap is what an admin may grow their text to without being told, so a
 * description that only fits beside a short prefix does not really fit.
 *
 * The pointer sentence is measured the same way, for the same reason. It ends
 * every file tool's description and its length moves with a DEPLOYMENT SETTING
 * — the guide's file name — so a description measured beside the nine
 * characters of `AGENTS.md` would pass here and arrive cut on a deployment
 * that renamed its guide. Whatever pointer a description actually carries is
 * discounted and charged at {@link SHARED_RULES_POINTER_MAX} instead.
 */
export function clientVisibleLength(tool: Pick<UtcpTool, 'name' | 'description'>): number {
  const own = tool.description?.length ?? 0;
  // A prefixed tool with no description of its own is still handed the prefix,
  // and nothing else — `prefixToolDescription` sends the prefix alone, with no
  // blank line after it. Measuring that as zero would under-report the only
  // text the client got.
  if (own === 0) return PREFIXED_TOOLS.has(tool.name) ? TOOL_PREFIX_CAP : 0;
  // The pointer at its worst case rather than at this layout's: swap the one
  // it carries for the longest it could be. A description that does not end
  // with it (`start_session`, the proxied tools) is charged nothing.
  const pointer = sharedRulesPointer();
  const atWorstPointer = tool.description!.endsWith(pointer)
    ? own - pointer.length + SHARED_RULES_POINTER_MAX
    : own;
  // `+ 2` for the blank line `prefixToolDescription` puts between the two.
  return PREFIXED_TOOLS.has(tool.name) ? atWorstPointer + TOOL_PREFIX_CAP + 2 : atWorstPointer;
}
