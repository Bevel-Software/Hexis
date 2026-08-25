import { describe, it, expect } from 'vitest';
import {
  parseYamlSubset,
  hasAccessFrontmatterExtension,
  registerAccessFrontmatterExtensions,
  accessFrontmatterExtensionList,
  parseOwnAccessEntries,
} from '../access-grammar.js';
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

describe('the access-frontmatter extension set', () => {
  it('covers nodes and tool manuals out of the box', () => {
    // `.tool` is whole-document YAML with its verbs as ordinary keys inside;
    // `access.md` is covered by `.md`.
    expect(hasAccessFrontmatterExtension('Data/E/Knowledge/T.md')).toBe(true);
    expect(hasAccessFrontmatterExtension('Plugins/E/tools/github.tool')).toBe(true);
    expect(hasAccessFrontmatterExtension('Plugins/E/access.md')).toBe(true);
  });

  it('covers nothing else until an overlay registers it', () => {
    // The grammar is core's; the file kinds are not necessarily. An overlay
    // that ships its own whole-document configuration registers its extensions
    // at boot — core knows about neither the files nor the feature.
    expect(hasAccessFrontmatterExtension('Agents/delivery-coder.agent')).toBe(false);
    expect(hasAccessFrontmatterExtension('Pipelines/Coding-Delivery.pipeline')).toBe(false);

    registerAccessFrontmatterExtensions(['.pipeline', '.agent']);

    expect(hasAccessFrontmatterExtension('Agents/delivery-coder.agent')).toBe(true);
    expect(hasAccessFrontmatterExtension('Pipelines/Coding-Delivery.pipeline')).toBe(true);
    // A near-miss must still miss: a backup is not a live grant.
    expect(hasAccessFrontmatterExtension('Pipelines/X.pipeline.bak')).toBe(false);
  });

  it('is additive only, and idempotent', () => {
    // Removing an extension would silently drop grants that are already
    // enforced, so there is no way to remove one.
    const before = accessFrontmatterExtensionList().length;
    registerAccessFrontmatterExtensions(['.agent', '.agent', 'nodot']);
    expect(accessFrontmatterExtensionList()).toHaveLength(before);
    expect(accessFrontmatterExtensionList()).toContain('.md');
    expect(accessFrontmatterExtensionList()).toContain('.tool');
  });

  it('reads verbs out of a registered file kind, ignoring its other keys', () => {
    // The point of per-file access on these: they are configuration rather than
    // graph nodes, but they are exactly the files whose edits grant capability.
    // The verbs are ordinary keys sitting beside the rest of the definition,
    // exactly as a `.tool` carries them beside `id:` and `tools:`.
    registerAccessFrontmatterExtensions(['.pipeline']);
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
