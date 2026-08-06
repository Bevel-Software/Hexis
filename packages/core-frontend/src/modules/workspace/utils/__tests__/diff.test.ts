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
});
