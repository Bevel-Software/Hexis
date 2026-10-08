import type { Router, RequestHandler } from 'express';
import { callLine } from '@bevel-software/platform-mcp-core';
import type { IToolRegistry, JsonSchema, UtcpTool } from '../tool-registry/tool.contract.js';
import { TOOL_DESCRIPTION_CAP } from '../tool-registry/description-length.js';
import { GUIDE_FIRST_SENTENCE } from '../tool-registry/guide-first.js';
import { ToolError, type ToolContext } from '../tool-helpers/tool.contract.js';
import { toolDef } from '../tool-helpers/tool-def.js';
import { bodyEnvelope, declareRouteTool } from '../tool-helpers/route-tool-schemas.js';
import type { ToolHandlerFactory } from '../tool-helpers/tool-handler.js';
import type { ISkillService } from './skills.contract.js';
import { EXTERNAL_KB_MANUAL_NAME } from '../tool-manuals/tool-manuals.contract.js';
import type { IAllowedToolsChecker } from './allowed-tools-check.js';
import { CAN_WRITE_CLAUSE, defaultBranchWriteVerdicts, type DefaultBranchWriteDeps } from '../tool-helpers/index.js';

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

/** What `list_skills` takes. A const so the route's check and the def share one declaration. */
const LIST_SKILLS_INPUTS = {
  type: 'object' as const,
  properties: { branch: BRANCH_SKILLS_INPUT },
  additionalProperties: false,
};

/** What `get_skill` takes. A const for the same reason as {@link LIST_SKILLS_INPUTS}. */
const GET_SKILL_INPUTS = {
  type: 'object' as const,
  properties: {
    name: { type: 'string' as const, minLength: 1, description: 'Skill name (its folder name, e.g. `rfi`).' },
    file: {
      type: 'string' as const,
      description:
        'Optional bundled file path relative to the skill folder (e.g. `scripts/build_xlsx.py`) — ' +
        'fetch its content instead of the body.',
    },
    version: {
      type: 'string' as const,
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
  /**
   * Where `canWrite` is judged: the access layer and the default branch's
   * workspace. Without it every verdict is `false` — the safe answer, which
   * sends the agent to a change request rather than a direct write.
   */
  writeVerdicts?: DefaultBranchWriteDeps,
): void {
  /**
   * Whether the caller may commit each repo-relative path directly on the
   * default branch — one batch per call, whichever branch was read (see
   * `defaultBranchWriteVerdicts`).
   */
  const verdictsFor = (ctx: ToolContext, paths: string[]): Promise<Map<string, boolean>> =>
    writeVerdicts
      ? defaultBranchWriteVerdicts(writeVerdicts, ctx, paths)
      : Promise.resolve(new Map(paths.map((p) => [p, false])));

  /**
   * Every repo-relative file `get_skill`'s `canWrite` covers: the skill's
   * `SKILL.md` and bundled files as the DEFAULT branch has them. `loaded` is
   * reused when it already is the default branch's latest copy; otherwise the
   * released skill is looked up, and the loaded copy stands in only when the
   * default branch has no such skill (one that exists only on a draft). Null —
   * judged `false` — when that lookup fails or refuses (fail closed), and
   * without a lookup when the verdict cannot be anything but `false`.
   */
  const skillFilesOnDefault = async (
    ctx: ToolContext,
    name: string,
    loaded: { path: string; files: string[] },
    loadedElsewhere: boolean,
  ): Promise<string[] | null> => {
    if (!writeVerdicts || ctx.scope !== 'write') return null;
    if (!loadedElsewhere) return [skillMdOf(loaded), ...loaded.files];
    const released = await skillService.getSkill(ctx.user.email, name).catch(() => null);
    if (released?.ok && released.kind === 'skill') return [skillMdOf(released.skill), ...released.skill.files];
    if (released?.ok === false && released.error === 'not_found') return [skillMdOf(loaded), ...loaded.files];
    return null;
  };

  registry.registerExternalTool((ctx) => buildListSkillsDef(skillService, ctx.userEmail));
  registry.registerInternalTool((ctx) => buildListSkillsDef(skillService, ctx.userEmail));
  registry.registerExternalTool((ctx) => buildGetSkillDef(skillService, ctx.userEmail));
  registry.registerInternalTool((ctx) => buildGetSkillDef(skillService, ctx.userEmail));
  // Both defs are built per catalog listing (their descriptions name the skills
  // THIS caller may read), so declare the arguments here as well: a direct REST
  // call that lands before the first listing must be checked against them too.
  declareRouteTool('list_skills', LIST_SKILLS_INPUTS);
  declareRouteTool('get_skill', GET_SKILL_INPUTS);

  router.post(
    '/agent/tools/list_skills',
    toolAuth,
    toolHandler(async (args, ctx: ToolContext) => {
      const skills = await skillService.listSkills(ctx.user.email, { branch: branchArg(args) });
      // Judged on each skill's SKILL.md, by the default branch's rules — a
      // skill only on a draft is judged where it would land. Each verdict goes
      // onto a COPY: the summaries may be the catalog shared across users.
      const verdicts = await verdictsFor(ctx, skills.map(skillMdOf));
      return { skills: skills.map((s) => ({ ...s, canWrite: verdicts.get(skillMdOf(s)) === true })) };
    }),
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
      const versioned = version !== undefined && version.trim().length > 0;
      if (branch !== undefined && versioned) {
        throw new ToolError(
          'get_skill takes `branch` or `version`, not both: `branch` loads the skill as that draft has it ' +
            'now, `version` loads a version the released skill declared. Pass one of them.',
          400,
        );
      }
      const result = await skillService.getSkill(ctx.user.email, name, file, { version, branch });
      if (!result.ok) return result;
      if (result.kind === 'file') {
        const verdicts = await verdictsFor(ctx, [result.file.path]);
        return { ...result, file: { ...result.file, canWrite: verdicts.get(result.file.path) === true } };
      }
      // The whole skill: true only when every one of its files may be written —
      // the files the skill has ON THE DEFAULT BRANCH, so a draft (or an older
      // version) that drops a write-denied bundled file does not turn the
      // verdict true. A skill only on the draft is judged by its draft files,
      // where they would land.
      const paths = await skillFilesOnDefault(ctx, name, result.skill, branch !== undefined || versioned);
      const verdicts = paths === null ? new Map<string, boolean>() : await verdictsFor(ctx, paths);
      const skill = { ...result.skill, canWrite: paths !== null && paths.every((p) => verdicts.get(p) === true) };
      if (!allowedTools) return { ...result, skill };
      return { ...result, skill, warnings: await allowedTools.check(ctx.user.email, result.skill.allowedTools) };
    }),
  );
}

/** The repo-relative `SKILL.md` of a skill, which `list_skills` judges it by. */
function skillMdOf(skill: { path: string }): string {
  return `${skill.path}/SKILL.md`;
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
  const rest = (shown: number): string =>
    shown < names.length ? `, and ${names.length - shown} more that list_skills names.` : '.';
  const head = 'Currently available skills: ';
  // The complete line first: it ends in a full stop, not in a count, so it
  // can fit where a shorter list plus its "and N more" tail would not.
  const complete = `${head}${names.join(', ')}.`;
  if (complete.length <= budget) return complete;
  // Otherwise one pass, accumulating: the cut is where the next name — with
  // the separator before it and the tail that would follow it — no longer
  // fits. (Rebuilding the joined prefix per candidate made this quadratic in
  // the catalog's size, on every catalog listing.)
  let shown = 0;
  let length = head.length;
  for (const name of names) {
    const added = (shown > 0 ? 2 : 0) + name.length;
    if (length + added + rest(shown + 1).length > budget) break;
    length += added;
    shown += 1;
  }
  if (shown === 0) {
    return names.length === 1
      ? '1 skill is currently available; list_skills names it.'
      : `${names.length} skills are currently available; list_skills names them.`;
  }
  return `${head}${names.slice(0, shown).join(', ')}${rest(shown)}`;
}

/**
 * What the fixed part of a description leaves the skills line, with the
 * `Call:` line ahead of everything (and the blank line after it) and the
 * guide-first sentence counted. The call line is generated from the schema
 * the tool advertises: its flat `inputs` inside the `body` envelope.
 */
function skillsLineBudget(name: string, inputs: JsonSchema, fixed: string): number {
  const call = callLine(`${EXTERNAL_KB_MANUAL_NAME}.${name}`, bodyEnvelope(inputs)).length + 2;
  return TOOL_DESCRIPTION_CAP - call - GUIDE_FIRST_SENTENCE.length - 1 - fixed.length;
}

const LIST_SKILLS_DESCRIPTION =
  'List the available skills (reusable specialist instructions) with their names, descriptions and, ' +
  'for a skill that declares one, its current `version` (its SKILL.md `metadata.version`, else a ' +
  'top-level `version`, else `lifecycle.version`). ' +
  'Discover what skills exist before specialist work, then `get_skill` to load one. ' +
  'Pass `branch` to list the skills as they are on a draft branch instead of the released set — ' +
  'what you need to try a skill you just wrote there; each skill that differs from the released ' +
  'one comes back with `unmerged: true` and that branch, meaning nobody has approved it. ' +
  'Each skill carries `canWrite`: whether you may change its SKILL.md directly on the default branch. ' +
  `${CAN_WRITE_CLAUSE} `;

async function buildListSkillsDef(skillService: ISkillService, userEmail?: string): Promise<UtcpTool> {
  return toolDef({
    name: 'list_skills',
    description:
      LIST_SKILLS_DESCRIPTION +
      (await availableSkillsLine(skillService, userEmail, skillsLineBudget('list_skills', LIST_SKILLS_INPUTS, LIST_SKILLS_DESCRIPTION))),
    path: '/api/agent/tools/list_skills',
    inputs: LIST_SKILLS_INPUTS,
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
              canWrite: {
                type: 'boolean',
                description:
                  'Whether you may commit a change to its SKILL.md directly on the default branch, under that ' +
                  'branch\'s access rules — the same answer whichever branch you listed. `false`: use a branch ' +
                  'and a change request; `file_stat` with `explainAccess` says why — and, when you can manage that ' +
                  'path\'s access, who can approve.',
              },
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
  'one the skill declared, or `branch` names a draft to load it from. ' +
  'The skill (or `file`) carries `canWrite`: whether you may change all of it directly on the default branch. ' +
  `${CAN_WRITE_CLAUSE} `;

async function buildGetSkillDef(skillService: ISkillService, userEmail?: string): Promise<UtcpTool> {
  return toolDef({
    name: 'get_skill',
    description:
      GET_SKILL_DESCRIPTION +
      (await availableSkillsLine(skillService, userEmail, skillsLineBudget('get_skill', GET_SKILL_INPUTS, GET_SKILL_DESCRIPTION))),
    path: '/api/agent/tools/get_skill',
    inputs: GET_SKILL_INPUTS,
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
            'proposal you are testing, not as approved instructions. `canWrite` is true only when you may ' +
            'commit a change to EVERY file of the skill (SKILL.md and each bundled file) directly on the ' +
            'default branch, whichever branch you read.',
          properties: {
            canWrite: {
              type: 'boolean',
              description:
                'Whether you may commit a change to every file of the skill (SKILL.md and each bundled file) ' +
                'directly on the default branch, under that branch\'s access rules — the same answer whichever ' +
                'branch you read.',
            },
          },
        },
        file: {
          type: 'object',
          description:
            'A bundled file: name, file, path, content — plus `unmerged` and `branch` when it came off ' +
            'a branch that changed the skill (the note stays beside the content, never inside it) — and ' +
            '`canWrite` for that file on the default branch.',
          properties: {
            canWrite: {
              type: 'boolean',
              description:
                'Whether you may commit a change to this file directly on the default branch, under that ' +
                'branch\'s access rules — the same answer whichever branch you read.',
            },
          },
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
