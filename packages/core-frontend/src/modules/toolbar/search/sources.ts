import {
  KNOWLEDGE_BASE_DIR,
  SKILLS_DIR,
  currentKbLayout,
  isPersonalPluginFolder,
  pluginOfPath,
  type FileTreeEntry,
} from '@bevel-software/platform-shared';
import type { LibrarySkillSummary } from '../../library/services/library.api';
import type { PluginSummary } from '../../library/services/plugins.api';
import type { ToolSecrets } from '../../secrets-vault/services/tool-secrets.api';
import { pathForPlugin, urlForLibraryItem } from '../../library/routes/library-paths';
import { pluginLabel, pluginNameForPath } from '../../library/utils/plugin-summary';
import { PERSONAL_PLUGIN_NAME } from '../../library/utils/personal-plugin';
import { displayFileName } from '../../../shared/display-file-name';

/**
 * What the search palette lists, flattened out of the two places it reads:
 * the Knowledge tree (pages) and the Library catalog (skills, tools, plugins).
 *
 * Pure, like `rank.ts` beside it: the palette hands in what it loaded and
 * gets rows back, so the row shapes — the name a person types, the faint
 * location after it, where Enter goes — are decided in one testable place.
 */

export type SearchResultKind = 'page' | 'skill' | 'tool' | 'plugin';

export interface SearchResult {
  /** Unique across both groups — it becomes the option's DOM id. */
  key: string;
  kind: SearchResultKind;
  /** What is shown, and what the query is matched against. */
  name: string;
  /** The faint text after the name: a page's folder, an item's plugin. */
  location: string;
  /**
   * Where choosing the row goes. A page is a WORKSPACE PATH, opened on the
   * branch on screen; a Library entry is a URL the Library already builds.
   */
  target: { kind: 'workspace'; path: string } | { kind: 'url'; url: string };
}

/** What a page is called, without the extension the reader did not choose. */
function pageTitle(path: string): string {
  return displayFileName(path).replace(/\.(md|markdown)$/i, '');
}

/**
 * The folder a page sits in, said the way the explorer says it: relative to
 * the Knowledge section, which hoists `KnowledgeBase/`'s children and folds
 * any other content folder in beside them. A page at the top of the section
 * sits in "Knowledge".
 */
function pageLocation(relativePath: string, kbDirName: string | null): string {
  let segments = relativePath.split('/');
  if (kbDirName && segments[0] === kbDirName) segments = segments.slice(1);
  if (segments[0] === KNOWLEDGE_BASE_DIR) segments = segments.slice(1);
  const folders = segments.slice(0, -1);
  return folders.length > 0 ? folders.join(' / ') : 'Knowledge';
}

/**
 * Page rows for the files `knowledgeFiles` returned. `excluded` names paths
 * that are in the tree without being openable — the caller's own proposed
 * files, which exist only behind a change request, so opening one by path
 * would land on a 404.
 */
export function pageResults(
  files: readonly FileTreeEntry[],
  kbDirName: string | null,
  excluded: { has(path: string): boolean },
): SearchResult[] {
  return files
    .filter((f) => !excluded.has(f.relativePath))
    .map((f) => ({
      key: `page:${f.relativePath}`,
      kind: 'page',
      name: pageTitle(f.relativePath),
      location: pageLocation(f.relativePath, kbDirName),
      target: { kind: 'workspace', path: f.relativePath },
    }));
}

/**
 * Where a skill or tool lives, as the Library names it: its plugin's display
 * name (the inline membership a skill carries, else the plugin whose folder
 * holds the path), the personal plugin for a personal shelf, and the shared
 * `Skills/` root by its own name.
 */
function itemLocation(
  path: string,
  memberships: readonly { name: string; linked: boolean }[] | undefined,
  plugins: readonly PluginSummary[],
): string {
  const plugin = memberships?.find((m) => !m.linked)?.name ?? pluginNameForPath(path, plugins);
  if (plugin) return pluginLabel(plugin, plugins);
  const folder = pluginOfPath(path, currentKbLayout());
  if (folder !== null && isPersonalPluginFolder(folder)) return PERSONAL_PLUGIN_NAME;
  if (path === SKILLS_DIR || path.startsWith(`${SKILLS_DIR}/`)) return SKILLS_DIR;
  return 'Skills & Tools';
}

export interface LibraryCatalog {
  skills: readonly LibrarySkillSummary[];
  tools: readonly ToolSecrets[];
  plugins: readonly PluginSummary[];
}

/**
 * Skill, tool and plugin rows, in that order. Skills and tools open at their
 * canonical item URL (`urlForLibraryItem`, the rule every Library card
 * follows), which needs the checkout's name — without it they are left out
 * rather than linked somewhere wrong. Plugins open on their own page.
 *
 * Proposals (skills and tools that exist only on a change request) are not
 * listed: their rows in the Library open a review, not a page, and a search
 * result that opens something other than the thing named would be a trap.
 */
export function libraryResults(catalog: LibraryCatalog, kbDirName: string | null): SearchResult[] {
  const { plugins } = catalog;
  const skills: SearchResult[] = kbDirName
    ? catalog.skills.map((s) => ({
        key: `skill:${s.path}`,
        kind: 'skill',
        name: s.name,
        location: itemLocation(s.path, s.plugins, plugins),
        target: { kind: 'url', url: urlForLibraryItem(kbDirName, { kind: 'skill', id: s.name, path: s.path }) },
      }))
    : [];
  const tools: SearchResult[] = kbDirName
    ? catalog.tools.map((t) => ({
        // Slug AND path: one `mcp.json` declares several servers, so the path
        // alone does not tell two of them apart.
        key: `tool:${t.path}:${t.slug}`,
        kind: 'tool',
        name: t.name,
        location: itemLocation(t.path, undefined, plugins),
        target: {
          kind: 'url',
          url: urlForLibraryItem(kbDirName, { kind: 'integration', id: t.slug, path: t.path }),
        },
      }))
    : [];
  const pluginRows: SearchResult[] = plugins.map((p) => ({
    key: `plugin:${p.name}`,
    kind: 'plugin',
    name: p.displayName || p.name,
    location: 'Plugin',
    target: { kind: 'url', url: pathForPlugin(p.name) },
  }));
  return [...skills, ...tools, ...pluginRows];
}
