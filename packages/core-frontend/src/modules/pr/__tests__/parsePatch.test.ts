import { describe, it, expect } from 'vitest';
import { parsePatch } from '../utils/parsePatch';

describe('parsePatch', () => {
  it('returns empty for no patch', () => {
    expect(parsePatch(undefined)).toEqual([]);
    expect(parsePatch('')).toEqual([]);
  });

  it('parses a simple hunk', () => {
    const patch = [
      '@@ -1,2 +1,3 @@',
      ' unchanged',
      '-removed',
      '+added',
      '+added2',
    ].join('\n');
    const out = parsePatch(patch);
    expect(out).toHaveLength(1);
    expect(out[0].oldStart).toBe(1);
    expect(out[0].newStart).toBe(1);
    expect(out[0].lines).toEqual([
      { type: 'same', text: 'unchanged' },
      { type: 'removed', text: 'removed' },
      { type: 'added', text: 'added' },
      { type: 'added', text: 'added2' },
    ]);
  });

  it('parses multiple hunks with distinct line offsets', () => {
    const patch = [
      '@@ -10,1 +10,2 @@',
      ' first-hunk-context',
      '+new-line-1',
      '@@ -50,1 +51,1 @@',
      '-deleted',
      '+replacement',
    ].join('\n');
    const out = parsePatch(patch);
    expect(out).toHaveLength(2);
    expect(out[0].oldStart).toBe(10);
    expect(out[0].newStart).toBe(10);
    expect(out[1].oldStart).toBe(50);
    expect(out[1].newStart).toBe(51);
  });

  it('handles single-line hunk headers (no comma/count)', () => {
    // GitHub emits `@@ -1 +1 @@` for single-line diffs.
    const patch = '@@ -1 +1 @@\n-old\n+new';
    const out = parsePatch(patch);
    expect(out).toHaveLength(1);
    expect(out[0].oldStart).toBe(1);
    expect(out[0].newStart).toBe(1);
  });

  it('ignores the "\\ No newline at end of file" marker', () => {
    const patch = [
      '@@ -1,1 +1,1 @@',
      '-old',
      '\\ No newline at end of file',
      '+new',
      '\\ No newline at end of file',
    ].join('\n');
    const out = parsePatch(patch);
    expect(out[0].lines).toEqual([
      { type: 'removed', text: 'old' },
      { type: 'added', text: 'new' },
    ]);
  });

  it('preserves empty context lines inside a hunk', () => {
    // An unprefixed empty string in the middle of a hunk represents an empty
    // context line. Losing it would misalign the rendered line numbers.
    const patch = ['@@ -1,3 +1,3 @@', ' a', '', ' c'].join('\n');
    const out = parsePatch(patch);
    expect(out[0].lines).toEqual([
      { type: 'same', text: 'a' },
      { type: 'same', text: '' },
      { type: 'same', text: 'c' },
    ]);
  });

  it('skips preamble before the first hunk', () => {
    const patch = [
      'diff --git a/foo b/foo',  // GitHub's patch strings don't normally include
      'index abc..def 100644',    // the `diff --git` headers, but be lenient.
      '--- a/foo',
      '+++ b/foo',
      '@@ -1,1 +1,1 @@',
      '-old',
      '+new',
    ].join('\n');
    const out = parsePatch(patch);
    expect(out).toHaveLength(1);
    expect(out[0].lines).toEqual([
      { type: 'removed', text: 'old' },
      { type: 'added', text: 'new' },
    ]);
  });

  it('returns empty when no hunk header is present', () => {
    expect(parsePatch('this is not a patch at all')).toEqual([]);
  });
});
