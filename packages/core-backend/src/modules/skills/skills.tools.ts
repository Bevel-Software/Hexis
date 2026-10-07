import type { Router, RequestHandler } from 'express';
import type { IToolRegistry, UtcpTool } from '../tool-registry/tool.contract.js';
import { TOOL_DESCRIPTION_CAP } from '../tool-registry/description-length.js';
import { GUIDE_FIRST_SENTENCE } from '../tool-registry/guide-first.js';
import { ToolError, type ToolContext } from '../tool-helpers/tool.contract.js';
import { toolDef } from '../tool-helpers/tool-def.js';
import type { ToolHandlerFactory } from '../tool-helpers/tool-handler.js';
import type { ISkillService } from './skills.contract.js';
import type { IAllowedToolsChecker } from './allowed-tools-check.js';

/**
 * The optional `branch` both skill tools declare. Optional on purpose, unlike
 * the required `branch` of the KB file tools: a skill read is answered by the
 * released catalog by default, and naming a branch is the caller asking for
 * something nobody has approved yet.
 */
const BRANCH_SKILLS_INPUT = {
  type: 'string' as const,
  description:
    'Optional: a draft branch to read the skills from instead of the released (default) branch — ' +
    'the branch you are working on. You must be able to read the branch and the skill on it; ' +
    'a branch that does not exist answers 404 naming it. Omit it for the approved skills.',
};

/**
 * Registers the two skill tools (both surfaces) and hosts their endpoints.
 *
 * The defs are registered as PROVIDERS (resolved at manual-build time) so each
 * tool's description can name the currently-available skills — the agent sees
 * what exists right in the tool catalog, no `list_skills` round-trip needed, and
 * it auto-updates as the default-branch catalog changes. The hosted routes are
 * static; only the description text is dynamic.
 *
 * Both tools take an optional `branch`. Without it they answer from the
 * released (default-branch) catalog — what the descriptions name, what the
 * browser menu lists and what the MCP prompt surface serves. With it they read
 * the skills as they are on that draft and say which of them nobody has
 * approved, so an agent can try the skill it just wrote without waiting for a
 * merge.
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
    toolHandler(async (args, ctx: ToolContext) => ({
      skills: await skillService.listSkills(ctx.user.email, { branch: branchArg(args) }),
    })),
  );

  router.post(
    '/agent/tools/get_skill',
    toolAuth,
    toolHandler(async (args, ctx: ToolContext) => {
      const name = typeof args.name === 'string' ? args.name : '';
      const file = typeof args.file === 'string' ? args.file : undefined;
      const version = typeof args.version === 'string' ? args.version : undefined;
      const branch = branchArg(args);
      if (!name) return { error: 'missing_name' };
      // Refused rather than ranked: a `version` is a point in the released
      // skill's history, a `branch` is a draft nobody has released — asked for
      // together, neither answer is the one the caller meant, and guessing
      // would serve instructions under a label that does not describe them.
      if (branch !== undefined && version !== undefined && version.trim().length > 0) {
        throw new ToolError(
          'get_skill takes `branch` or `version`, not both: `branch` loads the skill as that draft has it ' +
            'now, `version` loads a version the released skill declared. Pass one of them.',
          400,
        );
      }
      const result = await skillService.getSkill(ctx.user.email, name, file, { version, branch });
      if (!allowedTools || !result.ok || result.kind !== 'skill') return result;
      return { ...result, warnings: await allowedTools.check(ctx.user.email, result.skill.allowedTools) };
    }),
  );
}

/**
 * The `branch` a tool call named, or undefined when it named none (the
 * released catalog). A non-string or blank value is NOT a branch: it is taken
 * as absent, which answers from the default branch — the approved one. The
 * resolution of a real name, and the 404 for one the platform never heard of,
 * belong to the workspace layer, exactly as on the file tools.
 */
function branchArg(args: Record<string, unknown>): string | undefined {
  const branch = args.branch;
  return typeof branch === 'string' && branch.trim().length > 0 ? branch : undefined;
}

/**
 * "Currently available skills: `a`, `b`." (or a no-skills note), filtered to
 * what the caller may read, and cut to `budget` characters: as many names as
 * fit, then a count of the rest. The names are a convenience — `list_skills`
 * is the complete answer — and a description a client cuts from the end
 * would lose the tool's own tail to a catalog that grew; the budget is what
 * the tool's fixed text leaves under {@link TOOL_DESCRIPTION_CAP} once the
 * guide-first sentence the registry puts in front is counted.
 */
async function availableSkillsLine(skillService: ISkillService, userEmail: string | undefined, budget: number): Promise<string> {
  const skills = await skillService.listSkills(userEmail);
  if (skills.length === 0) return 'No skills are currently available.';
  const names = skills.map((s) => `\`${s.name}\``);
  const line = (shown: number): string =>
    shown === 0
      ? `${names.length} skills are currently available; list_skills names them.`
      : `Currently available skills: ${names.slice(0, shown).join(', ')}` +
        (shown < names.length ? `, and ${names.length - shown} more that list_skills names.` : '.');
  let shown = names.length;
  while (shown > 0 && line(shown).length > budget) shown -= 1;
  return line(shown);
}

/** What the fixed part of a description leaves the skills line, with the guide-first sentence counted. */
function skillsLineBudget(fixed: string): number {
  return TOOL_DESCRIPTION_CAP - GUIDE_FIRST_SENTENCE.length - 1 - fixed.length;
}

const LIST_SKILLS_DESCRIPTION =
  'List the available skills (reusable specialist instructions) with their names, descriptions and, ' +
  'for a skill that declares one, its current `version` (its SKILL.md `metadata.version`, else a ' +
  'top-level `version`, else `lifecycle.version`). ' +
  'Discover what skills exist before specialist work, then `get_skill` to load one. ' +
  'Pass `branch` to list the skills as they are on a draft branch instead of the released set — ' +
  'what you need to try a skill you just wrote there; each skill that differs from the released ' +
  'one comes back with `unmerged: true` and that branch, meaning nobody has approved it. ';

async function buildListSkillsDef(skillService: ISkillService, userEmail?: string): Promise<UtcpTool> {
  return toolDef({
    name: 'list_skills',
    description:
      LIST_SKILLS_DESCRIPTION +
      (await availableSkillsLine(skillService, userEmail, skillsLineBudget(LIST_SKILLS_DESCRIPTION))),
    path: '/api/agent/tools/list_skills',
    inputs: {
      type: 'object',
      properties: { branch: BRANCH_SKILLS_INPUT },
      additionalProperties: false,
    },
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
              unmerged: {
                type: 'boolean',
                description:
                  'Only when `branch` was passed, and only on a skill that differs from the released one ' +
                  '(it exists only on that branch, or was changed there): nobody has approved what it says.',
              },
              branch: { type: 'string', description: 'With `unmerged`: the branch the skill was read from.' },
            },
          },
        },
      },
    },
    tags: ['skills'],
  });
}

const GET_SKILL_DESCRIPTION =
  'Load a skill by name: returns its full instructions (SKILL.md body) to follow, plus the skill ' +
  'folder path and the list of bundled files. Pass `file` to fetch a bundled file’s content ' +
  '(e.g. a script) instead of the body. Loads the latest copy unless `version` names an earlier ' +
  'one the skill declared, or `branch` names a draft to load it from. ';

async function buildGetSkillDef(skillService: ISkillService, userEmail?: string): Promise<UtcpTool> {
  return toolDef({
    name: 'get_skill',
    description:
      GET_SKILL_DESCRIPTION +
      (await availableSkillsLine(skillService, userEmail, skillsLineBudget(GET_SKILL_DESCRIPTION))),
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
        branch: BRANCH_SKILLS_INPUT,
      },
      required: ['name'],
      additionalProperties: false,
    },
    outputs: {
      type: 'object',
      description: 'On success carries `skill` (or `file` when `file` was passed); on failure carries `error`.',
      properties: {
        skill: {
          type: 'object',
          description:
            'The loaded skill: name, description, body, files, …. Read from a `branch` that changed it, ' +
            'it also carries `unmerged: true` and that branch, and its `body` BEGINS with one line ' +
            'saying the skill comes from that unmerged branch and is not approved — treat it as a ' +
            'proposal you are testing, not as approved instructions.',
        },
        file: {
          type: 'object',
          description:
            'A bundled file: name, file, path, content — plus `unmerged` and `branch` when it came off ' +
            'a branch that changed the skill (the note stays beside the content, never inside it).',
        },
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
