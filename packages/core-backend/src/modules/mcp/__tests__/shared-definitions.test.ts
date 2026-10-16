import { describe, expect, it } from 'vitest';
import { SharedDefinitions } from '../shared-definitions.js';

describe('SharedDefinitions', () => {
  it('answers the first-seen copy of identical content, and holds at most maxEntries', () => {
    const defs = new SharedDefinitions(2);
    const first = [{ name: 'read_file' }];
    expect(defs.intern('tools', first)).toBe(first);
    expect(defs.intern('tools', [{ name: 'read_file' }])).toBe(first);
    defs.intern('tools', [{ name: 'a' }]);
    defs.intern('tools', [{ name: 'b' }]);
    expect(defs.size).toBe(2);
  });

  it('with maxEntries 0 shares nothing and holds nothing', () => {
    const defs = new SharedDefinitions(0);
    const first = [{ name: 'read_file' }];
    const second = [{ name: 'read_file' }];
    expect(defs.intern('tools', first)).toBe(first);
    expect(defs.intern('tools', second)).toBe(second);
    expect(defs.size).toBe(0);
  });
});
