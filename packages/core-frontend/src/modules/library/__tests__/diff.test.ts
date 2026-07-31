import { describe, it, expect } from 'vitest';
import { diffLines, hasChanges } from '../utils/diff';

describe('diffLines (LCS line differ)', () => {
  it('reports identical content as all-same', () => {
    const d = diffLines('a\nb\nc', 'a\nb\nc');
    expect(d).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'same', text: 'b' },
      { kind: 'same', text: 'c' },
    ]);
    expect(hasChanges(d)).toBe(false);
  });

  it('marks a replaced line as removed-then-added in place', () => {
    const d = diffLines('one\ntwo\nthree', 'one\nTWO\nthree');
    expect(d).toEqual([
      { kind: 'same', text: 'one' },
      { kind: 'removed', text: 'two' },
      { kind: 'added', text: 'TWO' },
      { kind: 'same', text: 'three' },
    ]);
  });

  it('handles pure insertions and deletions', () => {
    expect(diffLines('a\nc', 'a\nb\nc')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'added', text: 'b' },
      { kind: 'same', text: 'c' },
    ]);
    expect(diffLines('a\nb\nc', 'a\nc')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'removed', text: 'b' },
      { kind: 'same', text: 'c' },
    ]);
  });

  it('keeps unrelated equal lines matched across a multi-line rewrite', () => {
    const before = '# title\nstep 1\nstep 2\nstep 3\nfooter';
    const after = '# title\nstep 1 tightened\nstep 3\nnew step 4\nfooter';
    const d = diffLines(before, after);
    expect(d.filter((l) => l.kind === 'same').map((l) => l.text)).toEqual([
      '# title',
      'step 3',
      'footer',
    ]);
    expect(d.filter((l) => l.kind === 'removed').map((l) => l.text)).toEqual([
      'step 1',
      'step 2',
    ]);
    expect(d.filter((l) => l.kind === 'added').map((l) => l.text)).toEqual([
      'step 1 tightened',
      'new step 4',
    ]);
  });

  it('handles empty sides and trailing newlines', () => {
    expect(diffLines('', 'a\n')).toEqual([{ kind: 'added', text: 'a' }]);
    expect(diffLines('a\n', '')).toEqual([{ kind: 'removed', text: 'a' }]);
    expect(diffLines('', '')).toEqual([]);
  });
});
