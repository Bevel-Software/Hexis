import { describe, it, expect } from 'vitest';
import type { FileTreeEntry } from '@bevel-software/platform-shared';
import * as fileTree from '../fileTree';
import { checkoutRoot, omitPathFromTree, pathExistsInTree, suggestedPages, treeHasVisibleEntries } from '../fileTree';

const KB = 'knowledge-base';

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

/**
 * The one way anything reaches the repository. It is a LOOKUP of the name the
 * deployment gave the checkout — never a search for a folder that looks like
 * a knowledge base, which is what put a stray `KnowledgeBase/` on screen as
 * "Knowledge" while the real clone was folded in underneath it.
 */
describe('checkoutRoot', () => {
  const STRAYS = [
    dir('KnowledgeBase', [file('KnowledgeBase/Planted.md')]),
    dir('Plugins', [dir('Plugins/zz-stray', [file('Plugins/zz-stray/plugin.json')])]),
    dir('Skills', [dir('Skills/stray', [file('Skills/stray/SKILL.md')])]),
    file('Stray.docx'),
  ];

  it("is the workspace root's child of that name, and the same one with strays beside it", () => {
    const clean = dir('', [dir(KB, [dir(`${KB}/KnowledgeBase`, [])])]);
    const strewn = dir('', [...STRAYS, dir(KB, [dir(`${KB}/KnowledgeBase`, [])]), file('roles.yaml')]);
    expect(checkoutRoot(clean, KB)?.relativePath).toBe(KB);
    expect(checkoutRoot(strewn, KB)?.relativePath).toBe(KB);
    expect(checkoutRoot(strewn, KB)?.children?.map((c) => c.name)).toEqual(['KnowledgeBase']);
  });

  it('is null when the checkout is absent — never the stray that carries a well-known name', () => {
    expect(checkoutRoot(dir('', STRAYS), KB)).toBeNull();
    expect(checkoutRoot(null, KB)).toBeNull();
    expect(checkoutRoot(dir('', [dir(KB, [])]), null)).toBeNull();
  });

  it('looks exactly one level down: a namesake deeper in the tree is not the checkout', () => {
    const nested = dir('', [dir('wrapper', [dir(`wrapper/${KB}`, [dir(`wrapper/${KB}/KnowledgeBase`, [])])])]);
    expect(checkoutRoot(nested, KB)).toBeNull();
  });

  it("is not fooled by a FILE of the checkout's name", () => {
    expect(checkoutRoot(dir('', [file(KB)]), KB)).toBeNull();
  });

  /**
   * The bug was the finder, not any one caller. A module that exports a
   * name-search root finder again hands the next caller the same foot-gun,
   * so the module's surface is pinned: one resolver, and it takes the name.
   */
  it("is the module's only root resolver — no search-by-name finder survives", () => {
    expect(Object.keys(fileTree).filter((k) => /kbroot|findkb/i.test(k))).toEqual([]);
    expect(checkoutRoot.length).toBe(2);
  });
});

describe('suggestedPages', () => {
  it('offers documents, never a folder\'s access rules — at any depth, in any case', () => {
    const offered = suggestedPages(TREE, KB, 10).map((e) => e.relativePath);
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
    expect(suggestedPages(tree, KB, 10).map((e) => e.name)).toEqual(['People.md']);
  });

  it('honours the limit breadth-first and reports an empty knowledge base as such', () => {
    expect(suggestedPages(TREE, KB, 1).map((e) => e.name)).toEqual(['Onboarding.md']);
    expect(suggestedPages(dir('', [dir(KB, [dir(`${KB}/KnowledgeBase`, [])])]), KB, 3)).toEqual([]);
    expect(suggestedPages(null, KB, 3)).toEqual([]);
  });

  it('offers nothing from outside the checkout, and nothing at all without one', () => {
    const strewn = dir('', [
      dir('KnowledgeBase', [file('KnowledgeBase/Planted.md')]),
      ...(TREE.children ?? []),
    ]);
    expect(suggestedPages(strewn, KB, 10).map((e) => e.relativePath)).toEqual([
      `${KB}/KnowledgeBase/Onboarding.md`,
      `${KB}/KnowledgeBase/GTM/Pricing.md`,
    ]);
    expect(suggestedPages(dir('', [dir('KnowledgeBase', [file('KnowledgeBase/Planted.md')])]), KB, 10)).toEqual([]);
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

  it('counts nothing outside the checkout, and nothing when there is no checkout', () => {
    const strays = [d('KnowledgeBase', [f('KnowledgeBase/Planted.md')]), f('Stray.docx')];
    expect(treeHasVisibleEntries(d('.', [...strays, d('kb', [d('kb/KnowledgeBase')])]), 'kb')).toBe(false);
    expect(treeHasVisibleEntries(d('.', strays), 'kb')).toBe(false);
  });
});
