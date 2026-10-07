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
export const GUIDE_FIRST_SENTENCE = `Call \`${GET_AGENT_GUIDE_TOOL}\` first and read the platform's guide before anything else here.`;

/**
 * `description` as a client is handed it: the sentence ahead of it, once. A
 * description that already opens with the sentence is returned as it is, and
 * an absent or empty one becomes the sentence alone. The ONE place the
 * sentence is put in front of a description — the registry for the tools it
 * lists, the MCP service for the meta-tools it builds itself — so the two
 * cannot drift apart on what "once" means.
 */
export function guideFirstDescription(description: string | undefined): string {
  const own = description ?? '';
  if (own.startsWith(GUIDE_FIRST_SENTENCE)) return own;
  return own ? `${GUIDE_FIRST_SENTENCE} ${own}` : GUIDE_FIRST_SENTENCE;
}

/** `tool` as the catalog lists it: the sentence ahead of its own description, except on the guide's own tool. */
export function withGuideFirst(tool: UtcpTool): UtcpTool {
  if (tool.name === GET_AGENT_GUIDE_TOOL) return tool;
  const description = guideFirstDescription(tool.description);
  return description === tool.description ? tool : { ...tool, description };
}
