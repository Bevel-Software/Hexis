import { describe, test, expect, vi } from 'vitest';
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

  test('a shared prefix does not pad the typo budget', () => {
    // Scored whole, `mcp__hexis__weather_forecast` is within a third of its
    // length of `mcp__hexis__write_files` — the twelve prefix characters can
    // never be misspelt, yet they bought nine edits of slack.
    const withWriteFiles: VisibleTools = { ...visible, core: [...visible.core, 'write_files'] };
    const [retired] = checkAllowedTools(['mcp__hexis__weather_forecast'], withWriteFiles);
    expect(retired?.entry).toBe('mcp__hexis__weather_forecast');
    expect(retired?.suggestion).toBeUndefined();
    // A real typo behind the prefix is still found, in the entry's own namespace spelling.
    expect(checkAllowedTools(['KNOWLEDGE_BASE.read_fil'], visible)[0]?.suggestion).toBe('KNOWLEDGE_BASE.read_file');
    // Under a known manual only that manual's tools are candidates.
    expect(checkAllowedTools(['hubspot.create_contct'], visible)[0]?.suggestion).toBe('hubspot.create_contact');
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

  test('the catalog is read AS THE CALLER, so the answer is about tools they can see', async () => {
    // Spies, not plain stubs: the mocks above ignore their arguments, so a
    // regression that built the catalog for the wrong user — or for nobody —
    // would still return the same tools and pass every test above it.
    const listExternal = vi.fn(registry.listExternal);
    const listAccessible = vi.fn(manuals.listAccessible);
    const getDetail = vi.fn(manuals.getDetail);
    const spying = new AllowedToolsChecker({ listExternal }, { listAccessible, getDetail }, 'knowledge-base');

    expect(entries(await spying.check('alice@example.com', ['hubspot.serch']))).toEqual(['hubspot.serch']);
    expect(listExternal).toHaveBeenCalledWith({ userEmail: 'alice@example.com' });
    expect(listAccessible).toHaveBeenCalledWith('alice@example.com');
    // The per-manual detail decides which tools exist, so it is the caller's
    // view of that manual that must be read, not an ambient one.
    expect(getDetail).toHaveBeenCalledWith('alice@example.com', 'hubspot');
  });

  test('a batch of saves reads the catalog once, and answers per file in order', async () => {
    const listExternal = vi.fn(registry.listExternal);
    const listAccessible = vi.fn(manuals.listAccessible);
    const getDetail = vi.fn(manuals.getDetail);
    const spying = new AllowedToolsChecker({ listExternal }, { listAccessible, getDetail }, 'knowledge-base');

    const results = await spying.checkSaves('a@x.com', [
      { path: 'knowledge-base/Plugins/Sales/rfi/SKILL.md', content: skill('hubspot.serch') },
      { path: 'knowledge-base/Data/notes.md', content: skill('nope.nothing') },
      { path: 'knowledge-base/Skills/quote/SKILL.md', content: skill('Bash Read') },
      { path: 'knowledge-base/Skills/triage/SKILL.md', content: skill('retired_crm') },
    ]);

    expect(results.map(entries)).toEqual([['hubspot.serch'], [], [], ['retired_crm']]);
    expect(listExternal).toHaveBeenCalledTimes(1);
    expect(listAccessible).toHaveBeenCalledTimes(1);
    expect(getDetail).toHaveBeenCalledTimes(1);
  });

  test('a list of nothing but client tools reads no catalog at all', async () => {
    // `get_skill` runs on every skill use; a skill that names only the
    // client's tools must not cost a skill listing and a manual listing each time.
    const listExternal = vi.fn(registry.listExternal);
    const listAccessible = vi.fn(manuals.listAccessible);
    const getDetail = vi.fn(manuals.getDetail);
    const spying = new AllowedToolsChecker({ listExternal }, { listAccessible, getDetail }, 'knowledge-base');

    expect(await spying.check('a@x.com', ['Bash', 'Read', 'Bash(git:*)', 'mcp__github__create_issue', 'shell'])).toEqual([]);
    expect(listExternal).not.toHaveBeenCalled();
    expect(listAccessible).not.toHaveBeenCalled();
    expect(getDetail).not.toHaveBeenCalled();
  });
});
