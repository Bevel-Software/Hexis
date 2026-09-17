import { describe, test, expect } from 'vitest';
import {
  AllowedToolsChecker,
  checkAllowedTools,
  skillFileRepoPath,
  type VisibleTools,
} from '../allowed-tools-check.js';
import type { UtcpTool } from '../../tool-registry/tool.contract.js';
import type { ToolManualDetail, ToolManualSummary } from '../../tool-manuals/tool-manuals.contract.js';

const visible: VisibleTools = {
  core: ['read_file', 'get_skill', 'list_skills'],
  manuals: [
    // inline: its tools are known, so a tool under it can be proven absent
    { name: 'hubspot', tools: ['search', 'create_contact'] },
    // mcp: tools discovered at call time, so anything under it is accepted
    { name: 'gmail', tools: null },
  ],
};

const entries = (w: ReturnType<typeof checkAllowedTools>) => w.map((x) => x.entry);

describe('checkAllowedTools', () => {
  test('a known platform tool, in every spelling, is not flagged', () => {
    expect(
      checkAllowedTools(
        [
          'hubspot',
          'hubspot.search',
          'mcp__hexis__hubspot_search',
          'mcp__hexis__read_file',
          'read_file',
          'hubspot_create_contact',
          'gmail.send_message',
          'mcp__hexis__gmail_send_message',
          'KNOWLEDGE_BASE.read_file',
        ],
        visible,
      ),
    ).toEqual([]);
  });

  test('an unknown platform-looking name is flagged with the closest tool', () => {
    const warnings = checkAllowedTools(['hubspot.serch'], visible);
    expect(warnings).toEqual([
      {
        entry: 'hubspot.serch',
        suggestion: 'hubspot.search',
        message: expect.stringContaining('"hubspot.serch"'),
      },
    ]);
    expect(warnings[0]!.message).toContain('hubspot.search');
  });

  test('suggestions keep the spelling of the entry', () => {
    expect(checkAllowedTools(['mcp__hexis__read_fil'], visible)[0]?.suggestion).toBe('mcp__hexis__read_file');
    expect(checkAllowedTools(['hubspto'], visible)[0]?.suggestion).toBe('hubspot');
    // A manual whose tools are unknown suggests the manual, keeping the tool part.
    expect(checkAllowedTools(['gmial.send_message'], visible)[0]?.suggestion).toBe('gmail.send_message');
  });

  test('an unknown name with nothing close carries no suggestion', () => {
    const [w] = checkAllowedTools(['mcp__hexis__totally_unrelated_thing'], visible);
    expect(w?.entry).toBe('mcp__hexis__totally_unrelated_thing');
    expect(w?.suggestion).toBeUndefined();
    expect(w?.message).not.toContain('Did you mean');
  });

  test('client tool names are never flagged', () => {
    expect(
      checkAllowedTools(
        [
          'Bash',
          'Read',
          'Edit',
          'Write',
          'Glob',
          'Grep',
          'WebFetch',
          'Bash(git:*)',
          'mcp__github__create_issue',
          'mcp__hexis__*',
          'apply_patch',
          'shell',
        ],
        visible,
      ),
    ).toEqual([]);
  });

  test('a retired manual — no longer in the catalog — is flagged in every spelling', () => {
    const warnings = checkAllowedTools(['legacy_crm', 'legacy_crm.search', 'mcp__hexis__legacy_crm_search'], visible);
    expect(entries(warnings)).toEqual(['legacy_crm', 'legacy_crm.search', 'mcp__hexis__legacy_crm_search']);
  });
});

describe('skillFileRepoPath', () => {
  test('recognises skill files under the plugin and skills roots only', () => {
    expect(skillFileRepoPath('knowledge-base', 'knowledge-base/Plugins/Sales/rfi/SKILL.md')).toBe('Plugins/Sales/rfi/SKILL.md');
    expect(skillFileRepoPath('knowledge-base', './knowledge-base/Skills/triage/SKILL.md')).toBe('Skills/triage/SKILL.md');
    expect(skillFileRepoPath('knowledge-base', 'knowledge-base/Plugins/Sales/rfi/notes.md')).toBeNull();
    expect(skillFileRepoPath('knowledge-base', 'knowledge-base/Data/SKILL.md')).toBeNull();
  });
});

describe('AllowedToolsChecker', () => {
  const summary = (name: string, type: ToolManualSummary['type']): ToolManualSummary => ({
    slug: name,
    name,
    path: `Plugins/Sales/${name}.tool`,
    type,
  });
  const registry = {
    listExternal: async () => [{ name: 'read_file' }, { name: 'get_skill' }] as UtcpTool[],
  };
  const manuals = {
    listAccessible: async () => [summary('hubspot', 'inline'), summary('gmail', 'mcp')],
    getDetail: async (_email: string, slug: string): Promise<ToolManualDetail | null> =>
      slug === 'hubspot'
        ? {
            ...summary('hubspot', 'inline'),
            description: null,
            capabilities: [{ name: 'search', description: null }],
          }
        : null,
  };
  const checker = new AllowedToolsChecker(registry, manuals, 'knowledge-base');

  const skill = (tools: string) => `---\nname: rfi\ndescription: RFI.\nallowed-tools: ${tools}\n---\n\n# RFI\n`;

  test('checkSave resolves against the tools the user can see', async () => {
    const warnings = await checker.checkSave(
      'a@x.com',
      'knowledge-base/Plugins/Sales/rfi/SKILL.md',
      skill('Bash Read hubspot.search hubspot.serch gmail.send retired_crm'),
    );
    expect(entries(warnings)).toEqual(['hubspot.serch', 'retired_crm']);
    expect(warnings[0]?.suggestion).toBe('hubspot.search');
  });

  test('checkSave ignores files that are not skills', async () => {
    expect(await checker.checkSave('a@x.com', 'knowledge-base/Data/notes.md', skill('nope.nothing'))).toEqual([]);
  });

  test('a failing catalog yields no warnings rather than an error — the save is never blocked', async () => {
    const broken = new AllowedToolsChecker(
      { listExternal: async () => { throw new Error('down'); } },
      manuals,
      'knowledge-base',
    );
    await expect(
      broken.checkSave('a@x.com', 'knowledge-base/Plugins/Sales/rfi/SKILL.md', skill('hubspot.serch')),
    ).resolves.toEqual([]);
  });

  test('a capped capability list is treated as unknown, never as proof of absence', async () => {
    const capped = new AllowedToolsChecker(registry, manuals, 'knowledge-base', 1);
    expect(await capped.check('a@x.com', ['hubspot.whatever'])).toEqual([]);
  });
});
