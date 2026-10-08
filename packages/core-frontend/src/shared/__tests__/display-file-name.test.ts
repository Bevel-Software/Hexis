import { describe, it, expect } from 'vitest';
import { displayFileName, fileNameTooltip, isAccessRulesFile } from '../display-file-name';

describe('displayFileName', () => {
  it("calls a plugin's plugin.json Plugin settings, workspace- or repo-relative", () => {
    expect(displayFileName('knowledge-base/Plugins/GTM/plugin.json')).toBe('Plugin settings');
    expect(displayFileName('Plugins/GTM/plugin.json')).toBe('Plugin settings');
    expect(fileNameTooltip('knowledge-base/Plugins/GTM/plugin.json')).toBe('plugin.json');
  });

  it('leaves a plugin.json that is not directly in a plugin folder alone', () => {
    // A skill's bundled example is just a file with that name.
    expect(displayFileName('knowledge-base/Plugins/GTM/skills/demo/plugin.json')).toBe('plugin.json');
    expect(displayFileName('knowledge-base/KnowledgeBase/plugin.json')).toBe('plugin.json');
    expect(displayFileName('plugin.json')).toBe('plugin.json');
    expect(fileNameTooltip('knowledge-base/KnowledgeBase/plugin.json')).toBeUndefined();
  });

  it("calls a folder's access.md Who has access, at any depth", () => {
    expect(displayFileName('knowledge-base/access.md')).toBe('Who has access');
    expect(displayFileName('knowledge-base/Plugins/GTM/access.md')).toBe('Who has access');
    expect(displayFileName('KnowledgeBase/Legal/access.md')).toBe('Who has access');
    expect(fileNameTooltip('knowledge-base/KnowledgeBase/Legal/access.md')).toBe('access.md');
    expect(isAccessRulesFile('knowledge-base/KnowledgeBase/Legal/access.md')).toBe(true);
    // A note that only mentions access in its name is a note.
    expect(displayFileName('knowledge-base/KnowledgeBase/access-policy.md')).toBe('access-policy.md');
    expect(isAccessRulesFile('knowledge-base/KnowledgeBase/access-policy.md')).toBe(false);
  });

  it('shows every other file by its own name, with no tooltip of its own', () => {
    expect(displayFileName('knowledge-base/KnowledgeBase/Handbook.md')).toBe('Handbook.md');
    expect(displayFileName('Plugins/GTM/mcp.json')).toBe('mcp.json');
    expect(displayFileName('README.md')).toBe('README.md');
    expect(fileNameTooltip('knowledge-base/KnowledgeBase/Handbook.md')).toBeUndefined();
  });
});
