import { describe, it, expect } from 'vitest';
import { displayFileName, fileNameTooltip } from '../display-file-name';

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

  it('shows every other file by its own name, with no tooltip of its own', () => {
    expect(displayFileName('knowledge-base/KnowledgeBase/Handbook.md')).toBe('Handbook.md');
    expect(displayFileName('Plugins/GTM/mcp.json')).toBe('mcp.json');
    expect(displayFileName('README.md')).toBe('README.md');
    expect(fileNameTooltip('knowledge-base/KnowledgeBase/Handbook.md')).toBeUndefined();
  });
});
