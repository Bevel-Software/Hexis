import type { UtcpTool } from './tool.contract.js';

/** The one tool that returns the platform's guide (see `modules/agent-guide`). */
export const GET_AGENT_GUIDE_TOOL = 'get_agent_guide';

/**
 * The sentence every tool of the platform's own OPENS with: what to do before
 * anything else here. At the front, not the end, because clients cut a long
 * description from the end and the one instruction that must survive is this
 * one. The guide's own tool is the one that does not carry it — it IS what
 * the sentence points at.
 */
export const GUIDE_FIRST_SENTENCE = "Call `get_agent_guide` first and read the platform's guide before anything else here.";

/** `tool` as the catalog lists it: the sentence ahead of its own description. */
export function withGuideFirst(tool: UtcpTool): UtcpTool {
  if (tool.name === GET_AGENT_GUIDE_TOOL) return tool;
  const own = tool.description ?? '';
  if (own.startsWith(GUIDE_FIRST_SENTENCE)) return tool;
  return { ...tool, description: own ? `${GUIDE_FIRST_SENTENCE} ${own}` : GUIDE_FIRST_SENTENCE };
}
