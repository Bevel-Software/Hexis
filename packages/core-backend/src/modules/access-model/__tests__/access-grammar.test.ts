import { describe, it, expect } from 'vitest';
import { parseYamlSubset, hasAccessFrontmatterExtension, parseOwnAccessEntries } from '../access-grammar.js';
import { parseGroupsFile } from '../group-files.js';

describe('parseYamlSubset — inline empty collections', () => {
  it('reads `key: []` as an empty list, not the scalar "[]"', () => {
    const res = parseYamlSubset('owner: []');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual({ owner: [] });
  });

  it('reads `key: {}` as an empty mapping, not the scalar "{}"', () => {
    const res = parseYamlSubset('groups: {}');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual({ groups: {} });
  });
});

describe('parseGroupsFile — empty group sources', () => {
  it('accepts a bare `groups:` as a valid empty set', () => {
    const res = parseGroupsFile('groups:\n', 'groups.yaml');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.groups.size).toBe(0);
  });

  it('accepts the hand-written `groups: {}` as the same valid empty set', () => {
    const res = parseGroupsFile('groups: {}\n', 'groups.yaml');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.groups.size).toBe(0);
  });
});

describe('ACCESS_FRONTMATTER_EXTENSIONS — config files carry their own access', () => {
  it('covers nodes, tool manuals, and the AEL config files', () => {
    for (const p of ['a/b.md', 'access.md', 'x.tool', 'Coding-Delivery.pipeline', 'delivery-coder.agent']) {
      expect(hasAccessFrontmatterExtension(p)).toBe(true);
    }
    for (const p of ['notes.txt', 'page.html', 'x.pipeline.bak', 'agent.json']) {
      expect(hasAccessFrontmatterExtension(p)).toBe(false);
    }
  });

  it('reads verbs out of a whole-document YAML file, ignoring the definition around them', () => {
    // A `.pipeline` is one `---` fenced YAML document: the access verbs are
    // ordinary keys sitting beside `name:` and `do:`, exactly as a `.tool`
    // carries them beside `id:` and `tools:`.
    const pipeline = [
      '---',
      'name: Coding Delivery',
      'owner: Razvan <razvan@bevel.software>',
      'read:',
      '  - coding-agent <coding-agent@bevel.software>',
      'do:',
      '  - name: Coding',
      '---',
    ].join('\n');
    const entries = parseOwnAccessEntries(pipeline);
    expect(entries).not.toBeNull();
    expect(entries!.owner).toEqual([
      { kind: 'user', email: 'razvan@bevel.software', displayName: 'Razvan', deny: false },
    ]);
    expect(entries!.read).toEqual([
      { kind: 'user', email: 'coding-agent@bevel.software', displayName: 'coding-agent', deny: false },
    ]);
    expect(entries!.write).toEqual([]);
  });
});
