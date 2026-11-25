import { describe, it, expect } from 'vitest';
import { threeWayMerge } from '../three-way-merge';

describe('threeWayMerge', () => {
  it('merges edits onto an upstream change to other lines', () => {
    expect(threeWayMerge('a\nb\nc', 'a\nb\nmine', 'up\nb\nc')).toBe('up\nb\nmine');
  });

  it('returns null when both sides changed the same line differently', () => {
    expect(threeWayMerge('a\nb', 'mine\nb', 'theirs\nb')).toBeNull();
  });

  it('merges LF edits onto a CRLF file instead of calling every line a conflict', () => {
    // The editor hands back LF; the branch's bytes keep their CRs.
    const base = 'a\r\nb\r\nc';
    const ours = 'a\nb\nmine';
    const theirs = 'up\r\nb\r\nc';
    expect(threeWayMerge(base, ours, theirs)).toBe('up\r\nb\r\nmine');
  });

  it('leaves nothing to save when upstream already holds the edits in CRLF', () => {
    expect(threeWayMerge('a\r\nb', 'a\nmine', 'a\r\nmine')).toBe('a\r\nmine');
  });

  it("keeps each line's own ending in a file that mixes CRLF and LF", () => {
    const base = 'a\r\nb\nc\r\nd\n';
    const ours = 'a\nb\nc\nmine\n';
    const theirs = 'up\r\nb\nc\r\nd\n';
    // b keeps its LF and c its CRLF; mine ends as the d it replaced did.
    expect(threeWayMerge(base, ours, theirs)).toBe('up\r\nb\nc\r\nmine\n');
  });

  it('ends a line only the edits have as most of the file does', () => {
    const base = 'a\r\nb\r\nc\nd';
    const ours = 'a\nnew\nb\nc\nd';
    const theirs = 'a\r\nb\r\nc\nup';
    expect(threeWayMerge(base, ours, theirs)).toBe('a\r\nnew\r\nb\r\nc\nup');
  });

  it('merges LF edits onto a CR-only file and keeps its CR endings', () => {
    // A textarea hands back LF even for an old-Mac file that uses lone CRs.
    expect(threeWayMerge('a\rb\rc', 'a\nb\nmine', 'up\rb\rc')).toBe('up\rb\rmine');
  });

  it('merges edits near the end of a file longer than the engine takes as call arguments', () => {
    // Over 120k unchanged lines ahead of the edits: spread into one push,
    // they overran the argument limit and the merge threw.
    const many = Array.from({ length: 200_000 }, (_, i) => `line ${i}`);
    const base = [...many, 'a', 'b', 'c'].join('\n');
    const ours = [...many, 'a', 'b', 'mine'].join('\n');
    const theirs = [...many, 'up', 'b', 'c'].join('\n');
    expect(threeWayMerge(base, ours, theirs)).toBe([...many, 'up', 'b', 'mine'].join('\n'));
  });

  it('keeps the CRLF endings of a long file edited near the end, diffing only what changed', () => {
    // Blank lines repeat throughout a long Markdown file: diffed whole for
    // its line endings, that is the slow case for the dependency.
    const many = Array.from({ length: 200_000 }, (_, i) => (i % 2 ? '' : `line ${i}`));
    const crlf = (lines: string[]) => lines.join('\r\n');
    const base = crlf([...many, 'a', 'b', 'c']);
    const ours = [...many, 'a', 'b', 'mine'].join('\n');
    const theirs = crlf([...many, 'up', 'b', 'c']);
    expect(threeWayMerge(base, ours, theirs)).toBe(crlf([...many, 'up', 'b', 'mine']));
  });

  it('keeps the shared start and end around edits in the middle', () => {
    const base = 'h1\nh2\na\nb\nc\nt1\nt2';
    expect(threeWayMerge(base, 'h1\nh2\na\nb\nmine\nt1\nt2', 'h1\nh2\nup\nb\nc\nt1\nt2'))
      .toBe('h1\nh2\nup\nb\nmine\nt1\nt2');
    // Lines added at the end on one side, the start untouched.
    expect(threeWayMerge('a\nb', 'a\nb\nmine', 'up\nb')).toBe('up\nb\nmine');
    expect(threeWayMerge('a\nb\nc', 'a\nc', 'a\nb\nc\nd')).toBe('a\nc\nd');
  });
});
