import type { Router, RequestHandler } from 'express';
import type { IToolRegistry, UtcpTool } from '../tool-registry/tool.contract.js';
import type { ToolContext } from '../tool-helpers/tool.contract.js';
import { toolDef } from '../tool-helpers/tool-def.js';
import type { ToolHandlerFactory } from '../tool-helpers/tool-handler.js';
import type { ISkillService } from './skills.contract.js';
import type { IAllowedToolsChecker } from './allowed-tools-check.js';

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
  /** When given, a loaded skill carries `warnings` for `allowed-tools` entries that name no visible tool. */
  allowedTools?: IAllowedToolsChecker,
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
      const version = typeof args.version === 'string' ? args.version : undefined;
      if (!name) return { error: 'missing_name' };
      const result = await skillService.getSkill(ctx.user.email, name, file, { version });
      if (!allowedTools || !result.ok || result.kind !== 'skill') return result;
      return { ...result, warnings: await allowedTools.check(ctx.user.email, result.skill.allowedTools) };
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
      'List the available skills (reusable specialist instructions) with their names, descriptions and, ' +
      'for a skill that declares one, its current `version` (its SKILL.md `metadata.version`, else a ' +
      'top-level `version`, else `lifecycle.version`). ' +
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
              version: {
                type: 'string',
                description:
                  'The version the skill currently declares (`metadata.version`, else top-level `version`, ' +
                  'else `lifecycle.version` in its SKILL.md); absent when it declares none.',
              },
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
      '(e.g. a script) instead of the body. Loads the latest copy unless `version` names an earlier ' +
      'one the skill declared. ' +
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
        version: {
          type: 'string',
          description:
            'Optional: the declared version to load (e.g. `1.4.0` — the `version` that `list_skills` ' +
            'reports: `metadata.version`, else `version`, else `lifecycle.version`). Omitted, the skill is loaded as it ' +
            'is now, which is the latest. Given, the skill — or the `file` — is served as it was at the most ' +
            'recent commit that declared that version; a version the skill never declared answers ' +
            '`version_not_found` with the versions it did declare.',
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
        warnings: {
          type: 'array',
          description:
            'With `skill`: `allowed-tools` entries that look like platform tools but name none you can use — ' +
            'each `{ entry, message, suggestion? }`. Do not rely on such a tool.',
          items: { type: 'object' },
        },
        error: {
          type: 'string',
          description: 'Error code: `not_found`, `forbidden`, `invalid_file`, `missing_name`, `version_not_found`.',
        },
        versions: {
          type: 'array',
          items: { type: 'string' },
          description: 'With `version_not_found`: every version the skill has declared, newest first.',
        },
      },
    },
    tags: ['skills'],
  });
}
