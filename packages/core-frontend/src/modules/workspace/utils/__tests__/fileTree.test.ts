import { describe, it, expect } from 'vitest';
import type { FileTreeEntry } from '@bevel-software/platform-shared';
import { suggestedPages } from '../fileTree';

/**
 * The empty state's opening offer walks the tree the server already filtered
 * (`.bevelignore`, the reader's access), so visibility is inherited. What the
 * walk must decide for itself is what counts as a PAGE — and an `access.md`
 * is a document by extension only.
 */

const file = (relativePath: string): FileTreeEntry => ({
  name: relativePath.split('/').pop()!,
  relativePath,
  type: 'file',
});
const dir = (relativePath: string, children: FileTreeEntry[]): FileTreeEntry => ({
  name: relativePath.split('/').pop()!,
  relativePath,
  type: 'directory',
  children,
});

const TREE: FileTreeEntry = dir('', [
  dir('knowledge-base', [
    file('knowledge-base/access.md'),
    file('knowledge-base/roles.yaml'),
    dir('knowledge-base/KnowledgeBase', [
      file('knowledge-base/KnowledgeBase/access.md'),
      file('knowledge-base/KnowledgeBase/Access.MD'),
      file('knowledge-base/KnowledgeBase/Onboarding.md'),
      dir('knowledge-base/KnowledgeBase/GTM', [
        file('knowledge-base/KnowledgeBase/GTM/access.md'),
        file('knowledge-base/KnowledgeBase/GTM/Pricing.md'),
        file('knowledge-base/KnowledgeBase/GTM/deals.csv'),
      ]),
    ]),
    dir('knowledge-base/Plugins', [
      dir('knowledge-base/Plugins/GTM', [file('knowledge-base/Plugins/GTM/README.md')]),
    ]),
  ]),
]);

describe('suggestedPages', () => {
  it('offers documents, never a folder\'s access rules — at any depth, in any case', () => {
    const offered = suggestedPages(TREE, 10).map((e) => e.relativePath);
    expect(offered).toEqual([
      'knowledge-base/KnowledgeBase/Onboarding.md',
      'knowledge-base/KnowledgeBase/GTM/Pricing.md',
    ]);
  });

  it('honours the limit breadth-first and reports an empty knowledge base as such', () => {
    expect(suggestedPages(TREE, 1).map((e) => e.name)).toEqual(['Onboarding.md']);
    expect(suggestedPages(dir('', [dir('knowledge-base', [dir('knowledge-base/KnowledgeBase', [])])]), 3)).toEqual([]);
    expect(suggestedPages(null, 3)).toEqual([]);
  });
});
