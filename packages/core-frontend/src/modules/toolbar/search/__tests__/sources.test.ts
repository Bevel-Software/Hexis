import { describe, it, expect } from 'vitest';
import { DEFAULT_BRANCH, type FileTreeEntry } from '@bevel-software/platform-shared';
import type { PluginSummary } from '../../../library/services/plugins.api';
import { libraryResults, pageResults } from '../sources';

const KB = 'knowledge-base';
// Encoded as `urlForLibraryItem` encodes it, so a branch name with a `/` in it still matches.
const BRANCH = encodeURIComponent(DEFAULT_BRANCH);
const file = (relativePath: string): FileTreeEntry => ({
  name: relativePath.split('/').pop()!,
  relativePath,
  type: 'file',
});

const plugin = (name: string, displayName?: string): PluginSummary =>
  ({
    name,
    displayName,
    folders: [`Plugins/${name}`],
    canRead: true,
    canWrite: false,
    isOwner: false,
    skillCount: 0,
    toolCount: 0,
  }) as PluginSummary;

describe('pageResults', () => {
  it('names a page without its markdown extension and locates it by folder under Knowledge', () => {
    const rows = pageResults(
      [
        file(`${KB}/KnowledgeBase/Onboarding.md`),
        file(`${KB}/KnowledgeBase/GTM/Deals/pipeline.csv`),
        file(`${KB}/Legal/Terms.markdown`),
      ],
      KB,
      new Set(),
    );
    expect(rows.map((r) => [r.name, r.location])).toEqual([
      ['Onboarding', 'Knowledge'],
      ['pipeline.csv', 'GTM / Deals'],
      ['Terms', 'Legal'],
    ]);
    expect(rows[0].target).toEqual({ kind: 'workspace', path: `${KB}/KnowledgeBase/Onboarding.md` });
  });

  it('leaves out paths that are only proposals', () => {
    const proposed = `${KB}/KnowledgeBase/Draft.md`;
    const rows = pageResults([file(proposed), file(`${KB}/KnowledgeBase/Real.md`)], KB, new Set([proposed]));
    expect(rows.map((r) => r.name)).toEqual(['Real']);
  });
});

describe('libraryResults', () => {
  const catalog = {
    skills: [
      { name: 'rfi', description: '', path: 'Plugins/GTM/skills/rfi', plugins: [{ name: 'gtm', linked: false, granted: true }] },
      { name: 'shared-skill', description: '', path: 'Skills/shared-skill' },
    ],
    tools: [
      { slug: 'linear', name: 'Linear', path: 'Plugins/gtm/linear.tool', type: 'http', setup: null, canWrite: false, variables: [] },
      { slug: 'notion', name: 'Notion', path: 'Plugins/gtm/mcp.json', type: 'mcp', setup: null, canWrite: false, variables: [] },
    ],
    plugins: [plugin('gtm', 'GTM')],
  } as Parameters<typeof libraryResults>[0];

  it('links skills and tools to their canonical item URL and plugins to their page', () => {
    const rows = libraryResults(catalog, KB);
    expect(rows.map((r) => [r.kind, r.name, r.location])).toEqual([
      ['skill', 'rfi', 'GTM'],
      ['skill', 'shared-skill', 'Skills'],
      ['tool', 'Linear', 'GTM'],
      ['tool', 'Notion', 'GTM'],
      ['plugin', 'GTM', 'Plugin'],
    ]);
    expect(rows[0].target).toEqual({ kind: 'url', url: `/workspace/${BRANCH}/${KB}/Plugins/GTM/skills/rfi` });
    expect(rows[3].target).toEqual({ kind: 'url', url: `/workspace/${BRANCH}/${KB}/Plugins/gtm/mcp.json?server=notion` });
    expect(rows[4].target).toEqual({ kind: 'url', url: '/skills-and-tools/plugins/gtm' });
  });

  it('lists only plugins while the checkout name is unknown', () => {
    expect(libraryResults(catalog, null).map((r) => r.kind)).toEqual(['plugin']);
  });

  it('still lists the plugins skills belong to when the plugin index came back empty', () => {
    const rows = libraryResults(
      {
        ...catalog,
        skills: [
          ...catalog.skills,
          {
            name: 'brief',
            description: '',
            path: 'Plugins/Product/skills/brief',
            plugins: [
              { name: 'product', linked: false, granted: true },
              { name: 'gtm', linked: true, granted: true },
            ],
          },
        ],
        plugins: [],
      },
      KB,
    );
    expect(rows.filter((r) => r.kind === 'plugin').map((r) => [r.name, r.target])).toEqual([
      ['gtm', { kind: 'url', url: '/skills-and-tools/plugins/gtm' }],
      ['product', { kind: 'url', url: '/skills-and-tools/plugins/product' }],
    ]);
  });

  it('adds a plugin a skill names to the ones the index lists, once', () => {
    const rows = libraryResults(
      {
        ...catalog,
        skills: [
          ...catalog.skills,
          {
            name: 'brief',
            description: '',
            path: 'Shared/brief',
            plugins: [
              { name: 'gtm', linked: true, granted: true },
              { name: 'product', linked: true, granted: true },
            ],
          },
        ],
      },
      KB,
    );
    expect(rows.filter((r) => r.kind === 'plugin').map((r) => r.name)).toEqual(['GTM', 'product']);
  });
});
