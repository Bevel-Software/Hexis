import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useLinksOut } from '../useLinksOut';

const run = (path: string | null, content: string | null) =>
  renderHook(() => useLinksOut(path, content)).result.current;

describe('useLinksOut', () => {
  it('extracts the internal markdown links a document makes', () => {
    const out = run(
      'Knowledge/Invariant.md',
      'See [NodeType](../NodeTypes/NodeType.md) and [Platform](Bevel-Platform.md).\n',
    );
    expect(out).toEqual([
      { label: 'NodeType', target: '../NodeTypes/NodeType.md' },
      { label: 'Platform', target: 'Bevel-Platform.md' },
    ]);
  });

  it('keeps a heading anchor on an internal link', () => {
    expect(run('Knowledge/A.md', 'The [goal](Other.md#goal).')).toEqual([
      { label: 'goal', target: 'Other.md#goal' },
    ]);
  });

  // The predicate is `KbMarkdownView`'s own: exactly the links that open as
  // files in the workspace, and nothing that would take the reader off it.
  it('ignores external links and same-page anchors', () => {
    const out = run(
      'Knowledge/A.md',
      'An [external](https://example.com), an [anchor](#goal), and an [image](pic.png).',
    );
    expect(out).toEqual([]);
  });

  it('lists a destination once however many times it is linked', () => {
    const out = run('Knowledge/A.md', '[One](Same.md) then [again](Same.md).');
    expect(out).toEqual([{ label: 'One', target: 'Same.md' }]);
  });

  it('returns nothing for non-markdown content', () => {
    expect(run('Data/velocity.csv', 'a,b\n[x](y.md),2\n')).toEqual([]);
  });

  it('returns nothing before the content has loaded', () => {
    expect(run('Knowledge/A.md', null)).toEqual([]);
    expect(run(null, '[x](y.md)')).toEqual([]);
  });
});
