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
  // Registration is process-global and deliberately has no way to undo it, so
  // these tests never assert that a REAL extension is absent — that would
  // depend on no earlier test (in any order, in any file) having registered it.
  // They use extensions nothing else will ever register instead, which makes
  // every assertion here true regardless of what ran first.
  it('covers nodes and tool manuals out of the box', () => {
    // `.tool` is whole-document YAML with its verbs as ordinary keys inside;
    // `access.md` is covered by `.md`.
    expect(hasAccessFrontmatterExtension('Data/E/Knowledge/T.md')).toBe(true);
    expect(hasAccessFrontmatterExtension('Plugins/E/tools/github.tool')).toBe(true);
    expect(hasAccessFrontmatterExtension('Plugins/E/access.md')).toBe(true);
  });

  it('is case-sensitive on the path, as it always was', () => {
    // Which files are governed must not change because the set became
    // registrable. An uppercase extension was never a node and still is not.
    expect(hasAccessFrontmatterExtension('Data/E/Knowledge/T.MD')).toBe(false);
    expect(hasAccessFrontmatterExtension('Plugins/E/tools/github.TOOL')).toBe(false);
    // Registration itself normalizes, so a mixed-case REGISTRATION governs the
    // lowercase files it meant.
    registerAccessFrontmatterExtensions(['.CaseKind']);
    expect(hasAccessFrontmatterExtension('Overlay/x.casekind')).toBe(true);
    expect(hasAccessFrontmatterExtension('Overlay/x.CaseKind')).toBe(false);
  });

  it('covers nothing an overlay has not registered', () => {
    // The grammar is core's; the file kinds are not necessarily.
    expect(hasAccessFrontmatterExtension('Some/File.neverregistered')).toBe(false);
    expect(hasAccessFrontmatterExtension('notes.txt')).toBe(false);
  });

  it('covers a file kind once an overlay registers it', () => {
    expect(hasAccessFrontmatterExtension('Overlay/thing.testkind')).toBe(false);
    registerAccessFrontmatterExtensions(['.testkind']);
    expect(hasAccessFrontmatterExtension('Overlay/thing.testkind')).toBe(true);
    // A near-miss must still miss: a backup is not a live grant.
    expect(hasAccessFrontmatterExtension('Overlay/thing.testkind.bak')).toBe(false);
  });

  it('is additive and idempotent', () => {
    // Removing an extension would silently drop grants already being enforced,
    // so there is no way to remove one.
    registerAccessFrontmatterExtensions(['.testidem']);
    const after = accessFrontmatterExtensionList().length;
    registerAccessFrontmatterExtensions(['.testidem', '.TESTIDEM']);
    expect(accessFrontmatterExtensionList()).toHaveLength(after);
    expect(accessFrontmatterExtensionList()).toContain('.md');
    expect(accessFrontmatterExtensionList()).toContain('.tool');
  });

  it('throws on a malformed extension rather than skipping it', () => {
    // A typo would otherwise leave capability-granting files ungoverned, at
    // boot, with nothing to distinguish it from a successful registration.
    expect(() => registerAccessFrontmatterExtensions(['pipeline'])).toThrow(/malformed/);
    expect(() => registerAccessFrontmatterExtensions(['.two.dots'])).toThrow(/malformed/);
    expect(() => registerAccessFrontmatterExtensions([''])).toThrow(/malformed/);
    expect(hasAccessFrontmatterExtension('x.pipeline_typo_guard')).toBe(false);
  });

  it('applies nothing from a list that contains a malformed entry', () => {
    // Validate all, then apply: a list half-applied when it throws leaves later
    // scans governing a set nobody asked for.
    expect(() => registerAccessFrontmatterExtensions(['.validfirst', 'broken'])).toThrow(/malformed/);
    expect(hasAccessFrontmatterExtension('a.validfirst')).toBe(false);
  });

  it('reads verbs out of a registered file kind, ignoring its other keys', () => {
    // The point of per-file access on these: they are configuration rather than
    // graph nodes, but they are exactly the files whose edits grant capability.
    // The verbs are ordinary keys beside the rest of the definition, exactly as
    // a `.tool` carries them beside `id:` and `tools:`.
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

describe('parseOwnAccessEntries — whole-document YAML the subset parser cannot read', () => {
  // A `.tool` / `.pipeline` / `.agent` is one `---` fenced YAML document, and
  // real ones use folded and literal scalars and nested maps. The subset
  // parser stops at the first such line; the verbs must still be read.
  const doc = [
    '---',
    'apiVersion: bevel.software/v1',
    'kind: Agent',
    'id: delivery_coder',
    'description: >-',
    '  Writes and verifies the code for one delivery ticket. Runs the agent steps',
    '  of a coding pipeline.',
    'systemPrompt:',
    '  extend: |',
    '    You are executing exactly ONE step of a pipeline.',
    '    When your verdict is recorded, stop.',
    'env:',
    '  - { name: STAGING_URL, from: params, param: stagingUrl }',
    'owner: razvan.radulescu <razvan@bevel.software>',
    'read: coding-agent <coding-agent@bevel.software>',
    'write: Developer',
    '---',
    '',
    '# notes after the fence',
    '',
  ].join('\n');

  it('reads the verbs out of a document with folded and literal scalars', () => {
    const own = parseOwnAccessEntries(doc);
    expect(own).not.toBeNull();
    expect(own!.owner).toMatchObject([{ kind: 'user', email: 'razvan@bevel.software', deny: false }]);
    expect(own!.read).toMatchObject([{ kind: 'user', email: 'coding-agent@bevel.software', deny: false }]);
    expect(own!.write).toMatchObject([{ kind: 'role', role: 'developer', deny: false }]);
  });

  it('still answers null for a document that declares no verb, and for broken YAML', () => {
    expect(parseOwnAccessEntries('---\ndescription: >-\n  folded\n  text\n---\n')).toBeNull();
    // Broken for BOTH parsers: the folded scalar stops the subset one, the
    // unclosed flow sequence the full one.
    expect(parseOwnAccessEntries('---\ndescription: >-\n  folded\nread: [unclosed\n---\n')).toBeNull();
  });

  it('does not change what the subset parser already read', () => {
    // A node's frontmatter: the historical path, byte for byte.
    const node = '---\nnodeType: "[Project](../NodeTypes/Project.md)"\nid: project-x\nowner: Someone <s@x.io>\n---\n# Name\n';
    expect(parseOwnAccessEntries(node)!.owner).toMatchObject([{ kind: 'user', email: 's@x.io' }]);
  });
});

describe('parseOwnAccessEntries — quoted and flow-sequence verb values', () => {
  // The subset parser SUCCEEDS on these and hands the brackets or quotes to
  // the entry parser as text, so before the fallback they were dropped — or a
  // quoted role kept its quotes as part of its name. They are real YAML and
  // must resolve to the grants they spell.
  it('reads a flow sequence', () => {
    const own = parseOwnAccessEntries('---\nread: [coding-agent <coding-agent@bevel.software>, Developer]\n---\n');
    expect(own!.read).toMatchObject([
      { kind: 'user', email: 'coding-agent@bevel.software' },
      { kind: 'role', role: 'developer' },
    ]);
  });

  it('reads quoted scalars, inline and in a block list', () => {
    expect(parseOwnAccessEntries('---\nread: "coding-agent <coding-agent@bevel.software>"\n---\n')!.read).toMatchObject([
      { kind: 'user', email: 'coding-agent@bevel.software' },
    ]);
    expect(parseOwnAccessEntries("---\nwrite: 'Developer'\n---\n")!.write).toMatchObject([{ kind: 'role', role: 'developer' }]);
    expect(parseOwnAccessEntries('---\nowner:\n  - "Someone <s@x.io>"\n---\n')!.owner).toMatchObject([
      { kind: 'user', email: 's@x.io' },
    ]);
  });

  it('leaves the plain forms on the subset path', () => {
    // An empty flow collection and bare scalars are the subset parser\'s own
    // grammar; nothing about them asks for the full parser.
    expect(parseOwnAccessEntries('---\nread: []\nwrite: Developer\n---\n')).toMatchObject({
      read: [],
      write: [{ kind: 'role', role: 'developer' }],
    });
  });
});
