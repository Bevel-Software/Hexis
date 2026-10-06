import type { Router, RequestHandler } from 'express';
import type { IToolRegistry, UtcpTool } from '../tool-registry/tool.contract.js';
import { GET_AGENT_GUIDE_TOOL } from '../tool-registry/guide-first.js';
import { ToolError } from '../tool-helpers/tool.contract.js';
import { toolDef } from '../tool-helpers/tool-def.js';
import type { ToolHandlerFactory } from '../tool-helpers/tool-handler.js';
import { AGENT_GUIDE_FILE, joinGuideSections, type AgentGuideSectionsReader } from './agent-guide.js';

export { GET_AGENT_GUIDE_TOOL };

/**
 * The one tool that returns the guide on its own — whole, or one section by
 * id. It takes nothing else: the guide is the platform's text for this
 * deployment, the same for every caller and every branch, and reading it
 * touches no file — so no `branch`, no `sessionId`, and no access gate. The
 * other way to the same text is a `read_file` of `AGENTS.md` at the
 * repository root, which also carries the knowledge base's own `AGENTS.md`
 * when it has one (see `agent-guide.ts`).
 *
 * Registered as a PROVIDER on both surfaces, so the description names the
 * sections the guide has NOW — a distribution's hook may add its own — and
 * the in-process agent and an external one are told the same thing to read
 * first. This is the one tool the catalog does not open with "call
 * get_agent_guide first" (see `tool-registry/guide-first.ts`): it is what
 * that sentence points at, and says so itself.
 */
export function registerAgentGuideTool(
  registry: IToolRegistry,
  router: Router,
  toolAuth: RequestHandler,
  toolHandler: ToolHandlerFactory,
  sections: AgentGuideSectionsReader,
): void {
  const build = async (): Promise<UtcpTool> => {
    const list = await sections();
    return toolDef({
      name: GET_AGENT_GUIDE_TOOL,
      description:
        "The platform's guide to this knowledge base: its layout, where a new file goes, the rules every file tool " +
        'shares, access control, skills and tool manuals. ALWAYS call this first and read the guide before you do ' +
        'anything else in the platform. Returns `{ guide }` as markdown: the whole guide, or one section when ' +
        '`section` names one. The same text comes back from `read_file` on `' +
        AGENT_GUIDE_FILE +
        "` at the KB root, after the knowledge base's own " +
        AGENT_GUIDE_FILE +
        ' when it has one. Sections: ' +
        list.map((s) => `\`${s.id}\` (${s.title})`).join(', ') +
        '.',
      path: `/api/agent/tools/${GET_AGENT_GUIDE_TOOL}`,
      inputs: {
        type: 'object',
        properties: {
          section: {
            type: 'string',
            description:
              'Optional: the id of one section to read instead of the whole guide (the ids are listed in this ' +
              'description). Omit it for the whole guide.',
          },
        },
        additionalProperties: false,
      },
      outputs: {
        type: 'object',
        properties: {
          guide: { type: 'string', description: 'The guide, or the one section asked for, as markdown.' },
          section: { type: 'string', description: 'With `section`: the id of the section returned.' },
          title: { type: 'string', description: 'With `section`: its heading.' },
        },
        required: ['guide'],
      },
      tags: ['workspace'],
    });
  };
  registry.registerInternalTool(build);
  registry.registerExternalTool(build);

  router.post(
    `/agent/tools/${GET_AGENT_GUIDE_TOOL}`,
    toolAuth,
    toolHandler(async (args) => {
      const list = await sections();
      const wanted = typeof args.section === 'string' ? args.section.trim() : '';
      if (!wanted) return { guide: joinGuideSections(list) };
      const one = list.find((s) => s.id === wanted);
      if (!one) {
        throw new ToolError(
          `The guide has no section "${wanted}". Sections: ${list.map((s) => `\`${s.id}\``).join(', ')}. ` +
            'Omit `section` for the whole guide.',
          400,
        );
      }
      return { guide: one.body, section: one.id, title: one.title };
    }),
  );
}
