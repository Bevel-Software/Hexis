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
import type { UtcpTool } from './tool.contract.js';

/**
 * The ceiling on what a client is handed for one tool, enforced by
 * `__tests__/tool-description-length.test.ts`.
 *
 * DERIVED, not published: the clients that cut descriptions do not say where.
 * What was observed is claude.ai cutting around 500 characters (which is why
 * the deployment's purpose line is prepended rather than appended — see
 * `prefixToolDescription`) and other clients cutting the four-figure
 * descriptions this ticket shortened. 1,200 is set below the shortest length at
 * which a cut was observed, and is a number the reviewer may move: the point of
 * pinning it is that moving it is a decision someone takes, rather than a
 * paragraph someone appends.
 */
export const TOOL_DESCRIPTION_CAP = 1_200;

/**
 * The length of the description as a CLIENT receives it — which for the four
 * knowledge-base tools includes the deployment's purpose prefix, since the MCP
 * surface prepends it (`prefixToolDescription`) and the client cuts the result.
 * Measured at the prefix's CAP rather than at whatever the current admin wrote:
 * the cap is what an admin may grow their text to without being told, so a
 * description that only fits beside a short prefix does not really fit.
 */
export function clientVisibleLength(tool: Pick<UtcpTool, 'name' | 'description'>): number {
  const own = tool.description?.length ?? 0;
  if (own === 0) return 0;
  // `+ 2` for the blank line `prefixToolDescription` puts between the two.
  return PREFIXED_TOOLS.has(tool.name) ? own + TOOL_PREFIX_CAP + 2 : own;
}
