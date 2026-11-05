import type { Router, RequestHandler } from 'express';
import type { IToolRegistry, UtcpTool } from '../tool-registry/index.js';
import { GET_AGENT_GUIDE_TOOL, TOOL_DESCRIPTION_CAP } from '../tool-registry/index.js';
import { ToolError, toolDef } from '../tool-helpers/index.js';
import type { ToolHandlerFactory } from '../tool-helpers/index.js';
import {
  AGENT_GUIDE_FILE,
  START_HERE_SECTION_ID,
  WHOLE_GUIDE_SECTION,
  joinGuideSections,
  type AgentGuideSectionsReader,
} from './agent-guide.js';

export { GET_AGENT_GUIDE_TOOL };

/**
 * The one tool that returns the guide on its own: the start section when no
 * section is named, one section by id, or the whole guide (`all`). Start
 * section by default because this is the call every tool description tells
 * an agent, and each sub-agent it starts, to make first: answering it with
 * the whole guide made the most-read text the platform has also its longest.
 * It takes nothing else: the guide is the platform's text for this
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
    const describe = (sectionList: string) =>
      "The platform's guide to this knowledge base. ALWAYS call this first, before anything else in the " +
      'platform. With no `section` it returns the start section: the default branch every file tool takes, the ' +
      'first-call rules, and which section answers which question. Then fetch only the section a task needs, by ' +
      '`section`; only `"' +
      WHOLE_GUIDE_SECTION +
      '"` returns the whole guide. `read_file` on `' +
      AGENT_GUIDE_FILE +
      "` at the KB root answers with the same start section (after the knowledge base's own " +
      AGENT_GUIDE_FILE +
      ` when it has one). Returns \`{ guide }\` as markdown. Sections: ${sectionList}.`;
    // The description stays under the cap WHATEVER a distribution adds, in
    // three steps: every id with its title; every id alone; as many ids as
    // fit and a count of the rest. An id a client cut off the end would be a
    // section an agent cannot ask for — so nothing is ever cut: the one
    // complete list of sections is `sections` on the answer to a call
    // without one, which the description names when it cannot carry them
    // all itself.
    const titled = describe(list.map((s) => `\`${s.id}\` (${s.title})`).join(', '));
    const ids = list.map((s) => `\`${s.id}\``);
    const counted = (shown: number) =>
      describe(
        shown === 0
          ? `${ids.length}, named under \`sections\` in the answer`
          : [...ids.slice(0, shown), `and ${ids.length - shown} more, all named under \`sections\` in the answer`].join(', '),
      );
    let description = titled.length <= TOOL_DESCRIPTION_CAP ? titled : describe(ids.join(', '));
    for (let shown = ids.length; description.length > TOOL_DESCRIPTION_CAP && shown > 0; shown--) {
      description = counted(shown - 1);
    }
    return toolDef({
      name: GET_AGENT_GUIDE_TOOL,
      description,
      path: `/api/agent/tools/${GET_AGENT_GUIDE_TOOL}`,
      inputs: {
        type: 'object',
        properties: {
          section: {
            type: 'string',
            description:
              'Optional: the id of one section to read (the ids are listed in this description, and every one under ' +
              '`sections` in the answer), or `"' +
              WHOLE_GUIDE_SECTION +
              '"` for the whole guide. Omit it for the start section.',
          },
        },
        additionalProperties: false,
      },
      outputs: {
        type: 'object',
        properties: {
          guide: { type: 'string', description: 'The section asked for (the start section by default), or the whole guide, as markdown.' },
          sections: {
            type: 'array',
            description: `Without \`section\`, or with \`"${WHOLE_GUIDE_SECTION}"\`: every section of the guide, in order, by id and heading — the complete list.`,
            items: {
              type: 'object',
              properties: { id: { type: 'string' }, title: { type: 'string' } },
              required: ['id', 'title'],
            },
          },
          section: { type: 'string', description: 'The id of the one section returned.' },
          title: { type: 'string', description: 'Its heading.' },
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
    toolHandler(async (args, ctx) => {
      const list = await sections();
      const index = list.map((s) => ({ id: s.id, title: s.title }));
      const wanted = typeof args.section === 'string' ? args.section.trim() : '';
      // A distribution that dropped the start section gets the whole guide by
      // default, as before there was one: never an answer with nothing in it.
      const start = list.find((s) => s.id === START_HERE_SECTION_ID);
      // A connection made as an agent configuration is told so at the top of
      // the guide's first answer and of the whole guide: the catalog it
      // describes is narrowed to that agent. Everything is told nothing new,
      // so its guide is the same text.
      const connection = ctx.connectionScope?.describe() ?? null;
      const told = (guide: string) => ({
        guide: connection ? `> ${connection}\n\n${guide}` : guide,
        ...(connection ? { connection } : {}),
      });
      if (wanted === WHOLE_GUIDE_SECTION || (!wanted && !start)) return { ...told(joinGuideSections(list)), sections: index };
      if (!wanted) return { ...told(start!.body), section: start!.id, title: start!.title, sections: index };
      const one = list.find((s) => s.id === wanted);
      if (!one) {
        throw new ToolError(
          `The guide has no section "${wanted}". Sections: ${list.map((s) => `\`${s.id}\``).join(', ')}. ` +
            `Omit \`section\` for the start section, or pass \`"${WHOLE_GUIDE_SECTION}"\` for the whole guide.`,
          400,
        );
      }
      return { guide: one.body, section: one.id, title: one.title };
    }),
  );
}
