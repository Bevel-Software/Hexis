import { describe, it, expect } from 'vitest';
import type { FileTreeEntry } from '@bevel-software/platform-shared';
import {
  mergePendingIntoTree,
  omitPathFromTree,
  pathExistsInTree,
  subtreeHasVisibleEntries,
  subtreeWithheld,
  suggestedPages,
  treeHasVisibleEntries,
} from '../fileTree';

/**
 * A Library tree is one root of the listing, empty on its own terms: a
 * knowledge base full of notes still has an empty Skills tree.
 */
describe('subtreeHasVisibleEntries', () => {
  const kb: FileTreeEntry = {
    name: '.',
    relativePath: '.',
    type: 'directory',
    children: [
      {
        name: 'knowledge-base',
        relativePath: 'knowledge-base',
        type: 'directory',
        children: [
          {
            name: 'KnowledgeBase',
            relativePath: 'knowledge-base/KnowledgeBase',
            type: 'directory',
            children: [{ name: 'note.md', relativePath: 'knowledge-base/KnowledgeBase/note.md', type: 'file' }],
          },
          { name: 'Skills', relativePath: 'knowledge-base/Skills', type: 'directory', children: [] },
          {
            name: 'Plugins',
            relativePath: 'knowledge-base/Plugins',
            type: 'directory',
            children: [{ name: 'team', relativePath: 'knowledge-base/Plugins/team', type: 'directory', children: [] }],
          },
        ],
      },
    ],
  };

  it('is empty for a root with nothing under it, however full the rest of the tree is', () => {
    expect(treeHasVisibleEntries(kb, 'knowledge-base')).toBe(true);
    expect(subtreeHasVisibleEntries(kb, 'knowledge-base/Skills')).toBe(false);
  });

  it('counts a folder under the root as an entry', () => {
    expect(subtreeHasVisibleEntries(kb, 'knowledge-base/Plugins')).toBe(true);
  });

  it('is empty for a root the listing does not have', () => {
    expect(subtreeHasVisibleEntries(kb, 'knowledge-base/Agents')).toBe(false);
    expect(subtreeHasVisibleEntries(null, 'knowledge-base/Skills')).toBe(false);
  });
});

/**
 * What was kept out of ONE root is that root's own count, set by the server
 * per folder: a Skills tree emptied by the read rules says "nothing shared",
 * a Skills tree that is simply empty beside a withheld Knowledge does not.
 */
describe('subtreeWithheld', () => {
  const kb: FileTreeEntry = {
    name: '.',
    relativePath: '.',
    type: 'directory',
    withheld: 7,
    children: [
      {
        name: 'knowledge-base',
        relativePath: 'knowledge-base',
        type: 'directory',
        withheld: 7,
        children: [
          { name: 'KnowledgeBase', relativePath: 'knowledge-base/KnowledgeBase', type: 'directory', withheld: 4, children: [] },
          { name: 'Skills', relativePath: 'knowledge-base/Skills', type: 'directory', withheld: 3, children: [] },
          { name: 'Plugins', relativePath: 'knowledge-base/Plugins', type: 'directory', children: [] },
        ],
      },
    ],
  };

  it("reads one root's own count, not the listing's", () => {
    expect(subtreeWithheld(kb, 'knowledge-base/Skills')).toBe(3);
    expect(subtreeWithheld(kb, 'knowledge-base/Plugins')).toBe(0);
    expect(subtreeWithheld(kb, 'knowledge-base')).toBe(7);
  });

  it('is 0 for a root the listing does not have', () => {
    expect(subtreeWithheld(kb, 'knowledge-base/Agents')).toBe(0);
    expect(subtreeWithheld(null, 'knowledge-base/Skills')).toBe(0);
  });

  it('survives the pending-upload overlay, which copies the tree', () => {
    const merged = mergePendingIntoTree(kb, new Map([['knowledge-base/Plugins/new.md', { fullPath: 'knowledge-base/Plugins/new.md', type: 'file' }]]));
    expect(subtreeWithheld(merged, 'knowledge-base/Skills')).toBe(3);
    expect(merged.withheld).toBe(7);
  });
});

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

  it('skips a folder named after ANY reserved root, at any depth — the same set the root selection uses', () => {
    const page = (rel: string) => ({ name: rel.split('/').pop()!, relativePath: rel, type: 'file' as const });
    const tree = dir('', [
      dir('knowledge-base', [
        dir('knowledge-base/KnowledgeBase', [
          dir('knowledge-base/KnowledgeBase/Data', [page('knowledge-base/KnowledgeBase/Data/rows.md')]),
          dir('knowledge-base/KnowledgeBase/Pipelines', [page('knowledge-base/KnowledgeBase/Pipelines/run.md')]),
          dir('knowledge-base/KnowledgeBase/Skills', [page('knowledge-base/KnowledgeBase/Skills/x.md')]),
          dir('knowledge-base/KnowledgeBase/Team', [page('knowledge-base/KnowledgeBase/Team/People.md')]),
        ]),
      ]),
    ]);
    expect(suggestedPages(tree, 10).map((e) => e.name)).toEqual(['People.md']);
  });

  it('honours the limit breadth-first and reports an empty knowledge base as such', () => {
    expect(suggestedPages(TREE, 1).map((e) => e.name)).toEqual(['Onboarding.md']);
    expect(suggestedPages(dir('', [dir('knowledge-base', [dir('knowledge-base/KnowledgeBase', [])])]), 3)).toEqual([]);
    expect(suggestedPages(null, 3)).toEqual([]);
  });
});

describe('omitPathFromTree', () => {
  it('removes only the exact root control file and preserves a nested namesake', () => {
    const tree = dir('', [
      dir('knowledge-base', [
        file('knowledge-base/mcp-description.md'),
        dir('knowledge-base/KnowledgeBase', [
          file('knowledge-base/KnowledgeBase/mcp-description.md'),
        ]),
      ]),
    ]);

    const visible = omitPathFromTree(tree, 'knowledge-base/mcp-description.md');

    expect(pathExistsInTree(visible, 'knowledge-base/mcp-description.md')).toBe(false);
    expect(pathExistsInTree(visible, 'knowledge-base/KnowledgeBase/mcp-description.md')).toBe(true);
  });

  it('returns the original tree when the path is already absent', () => {
    expect(omitPathFromTree(TREE, 'knowledge-base/mcp-description.md')).toBe(TREE);
  });
});

describe('treeHasVisibleEntries', () => {
  const d = (rel: string, children: FileTreeEntry[] = []): FileTreeEntry => ({
    name: rel.split('/').pop()!,
    relativePath: rel,
    type: 'directory',
    children,
  });
  const f = (rel: string): FileTreeEntry => ({ name: rel.split('/').pop()!, relativePath: rel, type: 'file' });
  const kb = (...children: FileTreeEntry[]) =>
    d('.', [d('kb', [d('kb/KnowledgeBase'), d('kb/Skills'), ...children])]);

  it('is false for null, and for reserved roots with nothing in them', () => {
    expect(treeHasVisibleEntries(null, 'kb')).toBe(false);
    expect(treeHasVisibleEntries(kb(), 'kb')).toBe(false);
  });

  it('does not count the root .bevelignore', () => {
    expect(treeHasVisibleEntries(kb(f('kb/.bevelignore')), 'kb')).toBe(false);
  });

  it('counts a file or folder inside a reserved root, a stray folder, and a loose file', () => {
    expect(treeHasVisibleEntries(d('.', [d('kb', [d('kb/KnowledgeBase', [f('kb/KnowledgeBase/a.md')])])]), 'kb')).toBe(true);
    expect(treeHasVisibleEntries(d('.', [d('kb', [d('kb/Skills', [d('kb/Skills/Eng')])])]), 'kb')).toBe(true);
    expect(treeHasVisibleEntries(kb(d('kb/Legal')), 'kb')).toBe(true);
    expect(treeHasVisibleEntries(kb(f('kb/notes.md')), 'kb')).toBe(true);
  });

  it('reads a tree without the split from the KB clone folder down', () => {
    expect(treeHasVisibleEntries(d('.', [d('kb')]), 'kb')).toBe(false);
    expect(treeHasVisibleEntries(d('.', [d('kb', [f('kb/a.md')])]), 'kb')).toBe(true);
  });
});
