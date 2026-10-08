import { describe, it, expect } from 'vitest';
import { displayFileName, fileNameTooltip, isAccessRulesFile } from '../display-file-name';

const KB = 'knowledge-base';

describe('displayFileName', () => {
  it("calls a plugin's plugin.json Plugin settings, from a workspace path or a repository path", () => {
    expect(displayFileName('knowledge-base/Plugins/GTM/plugin.json', KB)).toBe('Plugin settings');
    expect(displayFileName('Plugins/GTM/plugin.json')).toBe('Plugin settings');
    expect(fileNameTooltip('knowledge-base/Plugins/GTM/plugin.json', KB)).toBe('plugin.json');
  });

  it('names a plugin under grouping folders the same way: a plugin has no fixed depth', () => {
    expect(displayFileName('knowledge-base/Plugins/departments/engineering/shared/ado/plugin.json', KB)).toBe(
      'Plugin settings',
    );
    expect(displayFileName('Plugins/departments/engineering/shared/ado/plugin.json')).toBe('Plugin settings');
  });

  it("leaves a skill's bundled plugin.json alone: it is an example, not a plugin's settings", () => {
    expect(displayFileName('knowledge-base/Plugins/GTM/skills/demo/plugin.json', KB)).toBe('plugin.json');
    expect(displayFileName('Plugins/departments/ado/skills/demo/assets/plugin.json')).toBe('plugin.json');
  });

  it('knows the plugins root only at the top of the repository', () => {
    // A folder somebody called Plugins inside the knowledge tree holds no plugins.
    expect(displayFileName('knowledge-base/KnowledgeBase/Plugins/x/plugin.json', KB)).toBe('plugin.json');
    expect(displayFileName('KnowledgeBase/Plugins/x/plugin.json')).toBe('plugin.json');
    // A workspace path is read from the clone folder; without it the root cannot be placed.
    expect(displayFileName('knowledge-base/Plugins/GTM/plugin.json')).toBe('plugin.json');
    expect(displayFileName('elsewhere/Plugins/GTM/plugin.json', KB)).toBe('plugin.json');
    expect(displayFileName('knowledge-base/KnowledgeBase/plugin.json', KB)).toBe('plugin.json');
    expect(displayFileName('Plugins/plugin.json')).toBe('plugin.json');
    expect(displayFileName('plugin.json')).toBe('plugin.json');
    expect(fileNameTooltip('knowledge-base/KnowledgeBase/plugin.json', KB)).toBeUndefined();
  });

  it("calls a folder's access.md Who has access, at any depth and in any case", () => {
    expect(displayFileName('knowledge-base/access.md', KB)).toBe('Who has access');
    expect(displayFileName('knowledge-base/Plugins/GTM/access.md', KB)).toBe('Who has access');
    expect(displayFileName('KnowledgeBase/Legal/access.md')).toBe('Who has access');
    expect(displayFileName('KnowledgeBase/Legal/Access.MD')).toBe('Who has access');
    expect(fileNameTooltip('knowledge-base/KnowledgeBase/Legal/access.md', KB)).toBe('access.md');
    expect(isAccessRulesFile('knowledge-base/KnowledgeBase/Legal/access.md')).toBe(true);
    expect(isAccessRulesFile('KnowledgeBase/Legal/ACCESS.md')).toBe(true);
    // A note that only mentions access in its name is a note.
    expect(displayFileName('knowledge-base/KnowledgeBase/access-policy.md', KB)).toBe('access-policy.md');
    expect(isAccessRulesFile('knowledge-base/KnowledgeBase/access-policy.md')).toBe(false);
  });

  it('shows every other file by its own name, with no tooltip of its own', () => {
    expect(displayFileName('knowledge-base/KnowledgeBase/Handbook.md', KB)).toBe('Handbook.md');
    expect(displayFileName('Plugins/GTM/mcp.json')).toBe('mcp.json');
    expect(displayFileName('README.md')).toBe('README.md');
    expect(fileNameTooltip('knowledge-base/KnowledgeBase/Handbook.md', KB)).toBeUndefined();
  });
});
