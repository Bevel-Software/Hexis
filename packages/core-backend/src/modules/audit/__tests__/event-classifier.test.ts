import { describe, expect, it } from 'vitest';
import { classifyToolCall, skillContaining, skillReadPath, splitUtcpName } from '../event-classifier.js';

const KB = 'KNOWLEDGE_BASE';
const ctx = { kbManualName: KB, catalogNames: new Map([['my_server', 'my-server']]) };
const skills = [
  { name: 'rfi', path: 'Plugins/Sales/rfi' },
  { name: 'deploy-checklist', path: 'Skills/Engineering/deploy-checklist' },
  // Nested under another skill's folder: the longer match must win.
  { name: 'rfi-followup', path: 'Plugins/Sales/rfi/followup' },
];

describe('splitUtcpName', () => {
  it('splits on the first dot and leaves a bare name without a manual', () => {
    expect(splitUtcpName('KNOWLEDGE_BASE.read_file')).toEqual({ manual: 'KNOWLEDGE_BASE', tool: 'read_file' });
    expect(splitUtcpName('notion.notion-search')).toEqual({ manual: 'notion', tool: 'notion-search' });
    expect(splitUtcpName('call_tool_chain')).toEqual({ manual: '', tool: 'call_tool_chain' });
  });
});

describe('skillReadPath', () => {
  it('asks for the skill catalog only for a platform read that names a path, or a get_skill with a name', () => {
    expect(skillReadPath(`${KB}.read_file`, { body: { path: 'Plugins/Sales/rfi/SKILL.md' } }, KB)).toBe(
      'Plugins/Sales/rfi/SKILL.md',
    );
    expect(skillReadPath(`${KB}.grep`, { path: 'Skills' }, KB)).toBe('Skills');
    expect(skillReadPath(`${KB}.get_skill`, { body: { name: 'rfi' } }, KB)).toBe('');
    // Not worth a catalog fetch: a write, a read with no path, another manual's tool, a meta-tool.
    expect(skillReadPath(`${KB}.write_file`, { body: { path: 'Plugins/x' } }, KB)).toBeNull();
    expect(skillReadPath(`${KB}.read_file`, { body: {} }, KB)).toBeNull();
    expect(skillReadPath('notion.search', { body: { path: 'Plugins/x' } }, KB)).toBeNull();
    expect(skillReadPath('call_tool_chain', { code: 'x' }, KB)).toBeNull();
  });
});

describe('skillContaining', () => {
  it('matches a path inside a skill folder on a segment boundary, from either root, longest folder first', () => {
    expect(skillContaining('Plugins/Sales/rfi/SKILL.md', skills)?.name).toBe('rfi');
    expect(skillContaining('knowledge-base/Plugins/Sales/rfi/scripts/build.py', skills)?.name).toBe('rfi');
    expect(skillContaining('./Skills\\Engineering\\deploy-checklist\\SKILL.md', skills)?.name).toBe('deploy-checklist');
    expect(skillContaining('Plugins/Sales/rfi/followup/SKILL.md', skills)?.name).toBe('rfi-followup');
    // The file tools accept a doubled separator as the same path; so does this.
    expect(skillContaining('Plugins//Sales/rfi/SKILL.md', skills)?.name).toBe('rfi');
    // A folder that merely shares a prefix is not the skill's folder.
    expect(skillContaining('Plugins/Sales/rfi-old/notes.md', skills)).toBeNull();
    expect(skillContaining('KnowledgeBase/Product/roadmap.md', skills)).toBeNull();
  });
});

describe('classifyToolCall', () => {
  it('logs the platform manual and the meta-tools as hexis capabilities, by bare name', () => {
    expect(classifyToolCall(`${KB}.write_file`, { body: { path: 'x' } }, ctx, null)).toEqual({
      kind: 'capability',
      manual: null,
      name: 'write_file',
    });
    expect(classifyToolCall('call_tool_chain', { code: 'x' }, ctx, null)).toEqual({
      kind: 'capability',
      manual: null,
      name: 'call_tool_chain',
    });
  });

  it("logs another manual's tool as a tool under its catalog name", () => {
    expect(classifyToolCall('my_server.search', { q: 'x' }, ctx, null)).toEqual({
      kind: 'tool',
      manual: 'my-server',
      name: 'search',
    });
    // An http `.tool` manual has no rewrite, so its registered name is the catalog name.
    expect(classifyToolCall('hubspot.search_contacts', {}, ctx, null)).toEqual({
      kind: 'tool',
      manual: 'hubspot',
      name: 'search_contacts',
    });
  });

  it('logs get_skill as a skill read, with the folder when the catalog knows it', () => {
    expect(classifyToolCall(`${KB}.get_skill`, { body: { name: 'rfi' } }, ctx, skills)).toEqual({
      kind: 'skill',
      manual: 'Plugins/Sales/rfi',
      name: 'rfi',
    });
    expect(classifyToolCall(`${KB}.get_skill`, { name: 'unknown' }, ctx, skills)).toEqual({
      kind: 'skill',
      manual: null,
      name: 'unknown',
    });
  });

  it('logs a platform read inside a skill folder as that skill, and elsewhere as the read', () => {
    expect(classifyToolCall(`${KB}.read_file`, { body: { path: 'Plugins/Sales/rfi/SKILL.md' } }, ctx, skills)).toEqual({
      kind: 'skill',
      manual: 'Plugins/Sales/rfi',
      name: 'rfi',
    });
    expect(classifyToolCall(`${KB}.list_files`, { body: { path: 'Skills/Engineering/deploy-checklist' } }, ctx, skills)).toEqual({
      kind: 'skill',
      manual: 'Skills/Engineering/deploy-checklist',
      name: 'deploy-checklist',
    });
    expect(classifyToolCall(`${KB}.read_file`, { body: { path: 'KnowledgeBase/Product/roadmap.md' } }, ctx, skills)).toEqual({
      kind: 'capability',
      manual: null,
      name: 'read_file',
    });
    // No catalog (the fetch failed): the honest fallback is the read itself.
    expect(classifyToolCall(`${KB}.read_file`, { body: { path: 'Plugins/Sales/rfi/SKILL.md' } }, ctx, null)).toEqual({
      kind: 'capability',
      manual: null,
      name: 'read_file',
    });
  });
});
