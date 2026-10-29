import { describe, expect, it } from 'vitest';
import { ONBOARD_PROMPT, ONBOARDING_GUIDE_SECTION_ID, promptsForSkills, skillPromptText } from '../skills.js';

describe('skillPromptText', () => {
  const base = {
    description: 'a skill',
    body: 'Do the thing.',
    path: 'skills/deploy',
  };

  it('appends the bundled-files footer with a copy-pasteable get_skill call', () => {
    const text = skillPromptText({
      ...base,
      name: 'deploy',
      files: ['skills/deploy/checklist.md'],
    });
    expect(text).toBe(
      'Do the thing.\n\n---\nSkill folder: skills/deploy\n' +
        'Bundled files (fetch each with the get_skill tool: { name: "deploy", file }): "checklist.md"',
    );
  });

  it('quotes each file name so a comma INSIDE one cannot read as a list separator', () => {
    const text = skillPromptText({
      ...base,
      name: 'deploy',
      files: ['skills/deploy/a, b.md', 'skills/deploy/c.md'],
    });
    expect(text).toContain(': "a, b.md", "c.md"');
  });

  it('escapes a skill name containing quotes so the example call stays valid', () => {
    const text = skillPromptText({
      ...base,
      name: 'say "hi"',
      files: ['skills/deploy/checklist.md'],
    });
    expect(text).toContain('{ name: "say \\"hi\\"", file }');
  });

  it('omits the footer when the skill bundles no files', () => {
    expect(skillPromptText({ ...base, name: 'deploy', files: [] })).toBe('Do the thing.');
  });
});

describe('promptsForSkills', () => {
  const deploy = { name: 'deploy', description: 'd' };

  it('puts the platform onboard prompt first when it is offered', () => {
    expect(promptsForSkills([deploy], true).map((p) => p.name)).toEqual(['onboard', 'deploy']);
  });

  it('lists only the skills when the connection is narrowed', () => {
    expect(promptsForSkills([deploy], false)).toEqual([{ name: 'deploy', description: 'd', arguments: [] }]);
  });

  it('lets a skill named onboard replace the platform prompt', () => {
    const own = { name: 'onboard', description: 'our own' };
    expect(promptsForSkills([own, deploy], true)).toEqual([
      { name: 'onboard', description: 'our own', arguments: [] },
      { name: 'deploy', description: 'd', arguments: [] },
    ]);
  });

  it('points the platform prompt at the guide section', () => {
    expect(ONBOARD_PROMPT.text).toContain(`section: "${ONBOARDING_GUIDE_SECTION_ID}"`);
  });
});
