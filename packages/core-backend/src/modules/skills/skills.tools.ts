import type { Router, RequestHandler } from 'express';
import type { IToolRegistry, UtcpTool } from '../tool-registry/tool.contract.js';
import type { ToolContext } from '../tool-helpers/tool.contract.js';
import { toolDef } from '../tool-helpers/tool-def.js';
import type { ToolHandlerFactory } from '../tool-helpers/tool-handler.js';
import type { ISkillService } from './skills.contract.js';

/**
 * Registers the two skill tools (both surfaces) and hosts their endpoints.
 *
 * The defs are registered as PROVIDERS (resolved at manual-build time) so each
 * tool's description can name the currently-available skills — the agent sees
 * what exists right in the tool catalog, no `list_skills` round-trip needed, and
 * it auto-updates as the default-branch catalog changes. The hosted routes are
 * static; only the description text is dynamic.
 */
export function registerSkillsTools(
  registry: IToolRegistry,
  router: Router,
  toolAuth: RequestHandler,
  toolHandler: ToolHandlerFactory,
  skillService: ISkillService,
): void {
  registry.registerExternalTool((ctx) => buildListSkillsDef(skillService, ctx.userEmail));
  registry.registerInternalTool((ctx) => buildListSkillsDef(skillService, ctx.userEmail));
  registry.registerExternalTool((ctx) => buildGetSkillDef(skillService, ctx.userEmail));
  registry.registerInternalTool((ctx) => buildGetSkillDef(skillService, ctx.userEmail));

  router.post(
    '/agent/tools/list_skills',
    toolAuth,
    toolHandler(async (_args, ctx: ToolContext) => ({
      skills: await skillService.listSkills(ctx.user.email),
    })),
  );

  router.post(
    '/agent/tools/get_skill',
    toolAuth,
    toolHandler(async (args, ctx: ToolContext) => {
      const name = typeof args.name === 'string' ? args.name : '';
      const file = typeof args.file === 'string' ? args.file : undefined;
      if (!name) return { error: 'missing_name' };
      return skillService.getSkill(ctx.user.email, name, file);
    }),
  );
}

/** "Currently available skills: `a`, `b`." (or a no-skills note), filtered to what the caller may read. */
async function availableSkillsLine(skillService: ISkillService, userEmail?: string): Promise<string> {
  const skills = await skillService.listSkills(userEmail);
  if (skills.length === 0) return 'No skills are currently available.';
  return `Currently available skills: ${skills.map((s) => `\`${s.name}\``).join(', ')}.`;
}

async function buildListSkillsDef(skillService: ISkillService, userEmail?: string): Promise<UtcpTool> {
  return toolDef({
    name: 'list_skills',
    description:
      'List the available skills (reusable specialist instructions) with their names and descriptions. ' +
      'Discover what skills exist before specialist work, then `get_skill` to load one. ' +
      (await availableSkillsLine(skillService, userEmail)),
    path: '/api/agent/tools/list_skills',
    inputs: { type: 'object', properties: {}, additionalProperties: false },
    outputs: {
      type: 'object',
      properties: {
        skills: {
          type: 'array',
          description: 'Available skills.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              description: { type: 'string' },
              version: { type: 'string' },
              path: { type: 'string' },
            },
          },
        },
      },
    },
    tags: ['skills'],
  });
}

async function buildGetSkillDef(skillService: ISkillService, userEmail?: string): Promise<UtcpTool> {
  return toolDef({
    name: 'get_skill',
    description:
      'Load a skill by name: returns its full instructions (SKILL.md body) to follow, plus the skill ' +
      'folder path and the list of bundled files. Pass `file` to fetch a bundled file’s content ' +
      '(e.g. a script) instead of the body. ' +
      (await availableSkillsLine(skillService, userEmail)),
    path: '/api/agent/tools/get_skill',
    inputs: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, description: 'Skill name (its folder name, e.g. `rfi`).' },
        file: {
          type: 'string',
          description:
            'Optional bundled file path relative to the skill folder (e.g. `scripts/build_xlsx.py`) — ' +
            'fetch its content instead of the body.',
        },
      },
      required: ['name'],
      additionalProperties: false,
    },
    outputs: {
      type: 'object',
      description: 'On success carries `skill` (or `file` when `file` was passed); on failure carries `error`.',
      properties: {
        skill: { type: 'object', description: 'The loaded skill: name, description, body, files, ….' },
        file: { type: 'object', description: 'A bundled file: name, file, path, content.' },
        error: { type: 'string', description: 'Error code: `not_found`, `forbidden`, `invalid_file`, `missing_name`.' },
      },
    },
    tags: ['skills'],
  });
}
