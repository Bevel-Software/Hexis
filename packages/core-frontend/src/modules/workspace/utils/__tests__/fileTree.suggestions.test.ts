import { describe, it, expect } from 'vitest';
import type { FileTreeEntry } from '@bevel-software/platform-shared';
import { suggestedPages } from '../fileTree';

/**
 * A knowledge base shaped like a real one: every folder carries the access
 * file that governs it, and the pages live in the folders below.
 *
 * That shape is the whole point of these tests. An `access.md` sits one level
 * ABOVE the pages of the folder it governs, so a breadth-first walk reaches
 * every access file in the tree before it reaches a single page — which made
 * the empty state offer four access files and nothing else on every KB with
 * subfolders. Scoping the walk to `KnowledgeBase/` only ever excluded the copy
 * at the repo root.
 */
const dir = (name: string, children: FileTreeEntry[]): FileTreeEntry => ({
  name,
  relativePath: `kb/KnowledgeBase/${name}`,
  type: 'directory',
  children,
});
const file = (parent: string, name: string): FileTreeEntry => ({
  name,
  relativePath: `kb/KnowledgeBase/${parent}/${name}`,
  type: 'file',
});
const subdir = (parent: string, name: string, children: FileTreeEntry[]): FileTreeEntry => ({
  name,
  relativePath: `kb/KnowledgeBase/${parent}/${name}`,
  type: 'directory',
  children,
});

const TREE: FileTreeEntry = {
  name: 'kb',
  relativePath: 'kb',
  type: 'directory',
  children: [
    {
      name: 'KnowledgeBase',
      relativePath: 'kb/KnowledgeBase',
      type: 'directory',
      children: [
        dir('GTM', [
          subdir('GTM', 'Processes', [file('GTM/Processes', 'Lead qualification.md')]),
          file('GTM', 'access.md'),
        ]),
        dir('IT Architecture', [
          subdir('IT Architecture', 'Systems', [file('IT Architecture/Systems', 'SAP.md')]),
        ]),
        dir('Legal', [
          file('Legal', 'access.md'),
          subdir('Legal', 'Contracts', [file('Legal/Contracts', 'NDA.md')]),
        ]),
        dir('Platform', [file('Platform', 'access.md')]),
        dir('Product', [file('Product', 'access.md')]),
      ],
    },
    { name: 'access.md', relativePath: 'kb/access.md', type: 'file' },
    { name: 'roles.yaml', relativePath: 'kb/roles.yaml', type: 'file' },
  ],
};

describe('suggestedPages', () => {
  it('offers no access file, at any depth', () => {
    const offered = suggestedPages(TREE, 4);
    expect(offered.map((e) => e.name)).not.toContain('access.md');
    // Stated as paths too: the root exclusion used to pass this test on its
    // own, and the nested copies are the ones that reach a real reader.
    expect(offered.map((e) => e.relativePath)).toEqual(
      expect.not.arrayContaining([
        'kb/access.md',
        'kb/KnowledgeBase/GTM/access.md',
        'kb/KnowledgeBase/Legal/access.md',
      ]),
    );
  });

  it('reaches the pages the access files were crowding out', () => {
    const offered = suggestedPages(TREE, 4).map((e) => e.relativePath);
    // Every page in the fixture sits below an access file. Skipping the access
    // files is what lets the walk descend to them at all.
    expect(offered).toContain('kb/KnowledgeBase/GTM/Processes/Lead qualification.md');
    expect(offered).toContain('kb/KnowledgeBase/IT Architecture/Systems/SAP.md');
    expect(offered).toContain('kb/KnowledgeBase/Legal/Contracts/NDA.md');
  });

  it('still offers nothing but documents, shallowest first', () => {
    const shallow: FileTreeEntry = {
      ...TREE,
      children: [
        {
          name: 'KnowledgeBase',
          relativePath: 'kb/KnowledgeBase',
          type: 'directory',
          children: [
            { name: 'Handbook.md', relativePath: 'kb/KnowledgeBase/Handbook.md', type: 'file' },
            { name: 'access.md', relativePath: 'kb/KnowledgeBase/access.md', type: 'file' },
            { name: 'logo.png', relativePath: 'kb/KnowledgeBase/logo.png', type: 'file' },
            dir('GTM', [file('GTM', 'Pricing.md')]),
          ],
        },
      ],
    };
    const offered = suggestedPages(shallow, 4).map((e) => e.relativePath);
    expect(offered).toEqual([
      'kb/KnowledgeBase/Handbook.md',
      'kb/KnowledgeBase/GTM/Pricing.md',
    ]);
  });

  it('says nothing rather than padding an empty knowledge base', () => {
    const empty: FileTreeEntry = {
      name: 'kb',
      relativePath: 'kb',
      type: 'directory',
      children: [
        {
          name: 'KnowledgeBase',
          relativePath: 'kb/KnowledgeBase',
          type: 'directory',
          children: [
            { name: 'access.md', relativePath: 'kb/KnowledgeBase/access.md', type: 'file' },
          ],
        },
      ],
    };
    expect(suggestedPages(empty, 4)).toEqual([]);
  });
});
