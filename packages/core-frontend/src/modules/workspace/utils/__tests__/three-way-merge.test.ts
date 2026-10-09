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
});
