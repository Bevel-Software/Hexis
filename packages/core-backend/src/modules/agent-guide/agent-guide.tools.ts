import type { Router, RequestHandler } from 'express';
import type { IToolRegistry } from '../tool-registry/tool.contract.js';
import { toolDef } from '../tool-helpers/tool-def.js';
import type { ToolHandlerFactory } from '../tool-helpers/tool-handler.js';
import type { AgentGuideReader } from './agent-guide.js';

export const GET_AGENT_GUIDE_TOOL = 'get_agent_guide';

/**
 * The one tool that returns the guide on its own. It takes nothing: the guide
 * is the platform's text for this deployment, the same for every caller and
 * every branch, and reading it touches no file — so no `branch`, no
 * `sessionId`, and no access gate. The other way to the same text is a
 * `read_file` of the guide's name at the repository root, which also carries
 * the knowledge base's own `AGENTS.md` when it has one (see `agent-guide.ts`).
 *
 * Registered on both surfaces: the in-process agent and an external one are
 * told the same thing to read first.
 */
export function registerAgentGuideTool(
  registry: IToolRegistry,
  router: Router,
  toolAuth: RequestHandler,
  toolHandler: ToolHandlerFactory,
  guide: AgentGuideReader,
): void {
  const def = toolDef({
    name: GET_AGENT_GUIDE_TOOL,
    description:
      "The platform's guide to this knowledge base: its layout, where a new file goes, the rules every file tool " +
      'shares, access control, skills and tool manuals. Read it before your first read or change. Returns ' +
      '`{ guide }`, the whole guide as markdown. The same text comes back from `read_file` on the guide\'s name at the ' +
      "KB root (`AGENTS.md`, or the name this deployment gave the guide), after the knowledge base's own file of " +
      'that name when it has one.',
    path: `/api/agent/tools/${GET_AGENT_GUIDE_TOOL}`,
    inputs: { type: 'object', properties: {}, additionalProperties: false },
    outputs: {
      type: 'object',
      properties: { guide: { type: 'string', description: 'The guide, as markdown.' } },
      required: ['guide'],
    },
    tags: ['workspace'],
  });
  registry.registerInternalTool(def);
  registry.registerExternalTool(def);

  router.post(
    `/agent/tools/${GET_AGENT_GUIDE_TOOL}`,
    toolAuth,
    toolHandler(async () => ({ guide: await guide() })),
  );
}
