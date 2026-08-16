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
  const footer = rel.length
    ? `\n\n---\nSkill folder: ${skill.path}\nBundled files (fetch each with the get_skill tool: { name: ${JSON.stringify(skill.name)}, file }): ${rel.join(', ')}`
    : '';
  return `${skill.body}${footer}`;
}
