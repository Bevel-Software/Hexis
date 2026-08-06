import { describe, it, expect } from 'vitest';
import { collapseUnchanged, diffLines, hasChanges } from '../utils/diff';

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

  /**
   * A KB file checked out on Windows has CRLF endings; a `<textarea>` hands its
   * value back as LF. Without normalisation a one-word edit renders as a
   * whole-file rewrite — which is what shipped before this test existed.
   */
  it('ignores CRLF-vs-LF so an edited file is not a whole-file rewrite', () => {
    const crlf = 'a\r\nb\r\nc\r\n';
    const lf = 'a\nb\nc\n';
    expect(hasChanges(diffLines(crlf, lf))).toBe(false);

    const edited = 'a\nb changed\nc\n';
    const d = diffLines(crlf, edited);
    expect(d.filter((l) => l.kind === 'removed').map((l) => l.text)).toEqual(['b']);
    expect(d.filter((l) => l.kind === 'added').map((l) => l.text)).toEqual(['b changed']);
  });
});

describe('collapseUnchanged', () => {
  it('folds long unchanged runs into a counted gap, keeping context', () => {
    const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'target', 'i', 'j'].join('\n');
    const after = before.replace('target', 'changed');
    const rows = collapseUnchanged(diffLines(before, after));

    const gaps = rows.filter((r) => r.kind === 'gap');
    expect(gaps).toHaveLength(1);
    // 8 lines precede the change; 2 are kept as context, so 6 are folded.
    expect(gaps[0]).toEqual({ kind: 'gap', count: 6 });
    expect(rows.some((r) => r.kind === 'removed' && r.text === 'target')).toBe(true);
    expect(rows.some((r) => r.kind === 'added' && r.text === 'changed')).toBe(true);
  });

  it('leaves a diff with nothing worth folding alone', () => {
    const rows = collapseUnchanged(diffLines('a\nb', 'a\nB'));
    expect(rows.some((r) => r.kind === 'gap')).toBe(false);
  });

  /**
   * Two changes `sameCount` unchanged lines apart. With the default context of
   * 2, four of those are kept either side, so the hidden run is `sameCount - 4`.
   */
  function betweenTwoChanges(sameCount: number) {
    const middle = Array.from({ length: sameCount }, (_, i) => `m${i}`);
    return collapseUnchanged(
      diffLines(['a', ...middle, 'z'].join('\n'), ['A', ...middle, 'Z'].join('\n')),
    );
  }

  it('emits a short hidden run verbatim rather than as a gap', () => {
    // A "1 unchanged line" button costs the row it hides and shows less.
    const rows = betweenTwoChanges(5);
    expect(rows.some((r) => r.kind === 'gap')).toBe(false);
    // `&&` narrows the union where `.filter().map()` would not.
    expect(rows.some((r) => r.kind === 'same' && r.text === 'm2')).toBe(true);
  });

  it('folds only runs longer than context * 2', () => {
    // Exactly at the threshold (4 hidden) — kept.
    const atThreshold = betweenTwoChanges(8);
    expect(atThreshold.some((r) => r.kind === 'gap')).toBe(false);
    expect(atThreshold.filter((r) => r.kind === 'same')).toHaveLength(8);

    // One past it (5 hidden) — folded, and the count is what was hidden.
    const past = betweenTwoChanges(9);
    expect(past.filter((r) => r.kind === 'gap')).toEqual([{ kind: 'gap', count: 5 }]);
  });

  it('honours a caller-supplied context when deciding what to fold', () => {
    // context 0 ⇒ nothing is kept for company and every run over 0 folds.
    const rows = collapseUnchanged(diffLines('a\nb\nc\nz', 'A\nb\nc\nZ'), 0);
    expect(rows.filter((r) => r.kind === 'gap')).toEqual([{ kind: 'gap', count: 2 }]);
  });
});
