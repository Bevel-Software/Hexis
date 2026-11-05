/**
 * Skills exposed as MCP prompts (slash commands in an MCP client).
 *
 * Both surfaces do this the same way and must keep doing it the same way: a
 * skill's instructions are the prompt body, and the bundled files are named at
 * the end with the exact call that fetches them. A person running the same
 * skill through the hosted endpoint and through the local server should get
 * identical text, so the formatting lives here rather than in either server.
 */

/** Minimal skill shapes the prompt bridge needs (no dependency on `modules/skills`). */
export interface SkillSummary {
  name: string;
  description: string;
  /**
   * The skill's repo-relative folder (`Plugins/Sales/rfi`), as the platform's
   * `list_skills` answers it. Optional: a listing from an older deployment
   * may omit it, and nothing that lists prompts needs it — the hosted proxy's
   * Audit log reads it to tell a read inside a skill folder from a file read.
   */
  path?: string;
}

export interface LoadedSkill extends SkillSummary {
  body: string;
  path: string;
  files: string[];
}

/** The prompt message text for a loaded skill: its instructions body + a pointer to bundled files. */
export function skillPromptText(skill: LoadedSkill): string {
  const rel = skill.files.map((f) =>
    f.startsWith(`${skill.path}/`) ? f.slice(skill.path.length + 1) : f,
  );
  // Each name is quoted: a comma inside a file name must not read as a list
  // separator, and the quoted form is exactly the `file` value get_skill takes.
  const footer = rel.length
    ? `\n\n---\nSkill folder: ${skill.path}\nBundled files (fetch each with the get_skill tool: { name: ${JSON.stringify(skill.name)}, file }): ${rel.map((f) => JSON.stringify(f)).join(', ')}`
    : '';
  return `${skill.body}${footer}`;
}

/**
 * The guide section that tells an agent how to onboard someone new. Named here
 * so the prompt below and the guide that serves the section cannot drift
 * apart: core's agent guide registers its section under this id.
 */
export const ONBOARDING_GUIDE_SECTION_ID = 'onboarding';

/**
 * The platform's own prompt, offered beside a workspace's skills on a
 * connection that is not narrowed to an agent: the way into the onboarding
 * section for clients that show prompts as slash commands. A narrowed
 * connection serves its agent's skills and nothing beside them. A skill of the
 * same name replaces it, so an organisation can ship its own onboarding.
 */
export const ONBOARD_PROMPT = Object.freeze({
  name: 'onboard',
  description:
    'Get started here: a short welcome, what you can do (ask, contribute, automate), then one real thing done together. ' +
    'Use when you are new or want to be onboarded.',
  text:
    `Onboard me. Read the guide's \`${ONBOARDING_GUIDE_SECTION_ID}\` section, ` +
    `get_agent_guide({ body: { section: "${ONBOARDING_GUIDE_SECTION_ID}" } }), and follow it.`,
});

/** A prompt as both surfaces list it: a skill, or the platform's own. */
export interface PromptSummary {
  name: string;
  description: string;
  arguments: [];
}

/**
 * The prompt list for a workspace: one prompt per skill, and, when
 * `offerOnboard`, the platform's own `onboard` first unless a skill already
 * takes that name.
 */
export function promptsForSkills(skills: readonly SkillSummary[], offerOnboard: boolean): PromptSummary[] {
  const prompts: PromptSummary[] = skills.map((s) => ({ name: s.name, description: s.description, arguments: [] }));
  if (!offerOnboard || skills.some((s) => s.name === ONBOARD_PROMPT.name)) return prompts;
  return [{ name: ONBOARD_PROMPT.name, description: ONBOARD_PROMPT.description, arguments: [] }, ...prompts];
}
