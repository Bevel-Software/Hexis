import { describe, it, expect } from 'vitest';
import { parseYamlSubset } from '../access-grammar.js';
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
