import { describe, expect, it } from 'vitest';
import { skillPromptText } from '../skills.js';

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
        'Bundled files (fetch each with the get_skill tool: { name: "deploy", file }): checklist.md',
    );
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
