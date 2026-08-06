import { describe, it, expect } from 'vitest';
import { computeDiff } from '../diff';

/**
 * `computeDiff` is THE line differ — the review module's rendered-markdown
 * viewer reads it directly and the change-requests module adapts it. These
 * tests pin the engine semantics both depend on.
 */
describe('computeDiff', () => {
  it('emits removed before added within one change run', () => {
    // `groupDiffBlocks` in MarkdownDiffViewer bundles consecutive
    // removed+added runs into one red/green block — interleaving would split
    // a single edit into several blocks.
    const out = computeDiff('a\nold line\nz', 'a\nnew line\nz');
    expect(out).toEqual([
      { type: 'same', text: 'a' },
      { type: 'removed', text: 'old line' },
      { type: 'added', text: 'new line' },
      { type: 'same', text: 'z' },
    ]);
  });

  it('normalises CRLF so a Windows checkout does not diff as a full rewrite', () => {
    // A KB file checked out on Windows carries \r\n while a <textarea> hands
    // back \n — without normalisation every line compares unequal.
    const out = computeDiff('a\r\nb\r\n', 'a\nb\nc\n');
    expect(out).toEqual([
      { type: 'same', text: 'a' },
      { type: 'same', text: 'b' },
      { type: 'added', text: 'c' },
    ]);
  });

  it('treats a trailing newline as line termination, not an extra empty line', () => {
    expect(computeDiff('a\n', 'a')).toEqual([{ type: 'same', text: 'a' }]);
  });

  it('diffs empty against content as pure additions', () => {
    expect(computeDiff('', 'a\nb')).toEqual([
      { type: 'added', text: 'a' },
      { type: 'added', text: 'b' },
    ]);
  });

  it('trims a common prefix and suffix around a multi-line change run', () => {
    const before = ['p1', 'p2', 'x1', 'x2', 'x3', 's1', 's2'].join('\n');
    const after = ['p1', 'p2', 'y1', 'y2', 's1', 's2'].join('\n');
    expect(computeDiff(before, after)).toEqual([
      { type: 'same', text: 'p1' },
      { type: 'same', text: 'p2' },
      { type: 'removed', text: 'x1' },
      { type: 'removed', text: 'x2' },
      { type: 'removed', text: 'x3' },
      { type: 'added', text: 'y1' },
      { type: 'added', text: 'y2' },
      { type: 'same', text: 's1' },
      { type: 'same', text: 's2' },
    ]);
  });

  it('degrades a middle over the cell cap to one whole-block replace', () => {
    // 2100 × 2100 unique middle lines exceed the ~4M-cell LCS budget; the
    // honest cheap answer is "everything here changed": all removed lines,
    // then all added lines, with the shared frame intact around them.
    const mid = (tag: string) => Array.from({ length: 2100 }, (_, i) => `${tag}${i}`);
    const before = ['head', ...mid('a'), 'tail'].join('\n');
    const after = ['head', ...mid('b'), 'tail'].join('\n');
    const out = computeDiff(before, after);
    expect(out).toHaveLength(2 + 2100 * 2);
    expect(out[0]).toEqual({ type: 'same', text: 'head' });
    expect(out.slice(1, 2101).every((l) => l.type === 'removed')).toBe(true);
    expect(out.slice(2101, 4201).every((l) => l.type === 'added')).toBe(true);
    expect(out[out.length - 1]).toEqual({ type: 'same', text: 'tail' });
  });

  it('caps each side independently, so a huge one-sided middle never reaches the LCS', () => {
    // The cell PRODUCT of 150k × 1 is tiny, but the DP table would still
    // allocate one row per left-side line — the per-side cap catches it. The
    // fallback output is identical to what an exact LCS would say here
    // anyway: everything removed, the one new line added.
    const before = Array.from({ length: 150_001 }, (_, i) => `line ${i}`).join('\n');
    const out = computeDiff(before, 'only line');
    expect(out).toHaveLength(150_002);
    expect(out.slice(0, 150_001).every((l) => l.type === 'removed')).toBe(true);
    expect(out[out.length - 1]).toEqual({ type: 'added', text: 'only line' });
  });
});
