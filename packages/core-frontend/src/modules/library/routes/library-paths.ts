import { DEFAULT_BRANCH, PLUGINS_DIR, pluginOfPath, isPersonalPluginFolder } from '@bevel-software/platform-shared';
import { matchPath } from 'react-router-dom';
import { kbFileUrl } from '../../workspace/routing/kb-routes';
import type { LibraryFilter } from '../utils/status';

/**
 * The Library's URL↔selection mapping, in one place and in both directions.
 *
 * Pure functions rather than logic inside the layout, because three surfaces
 * need them: the layout (to light the right sidebar row), every page that links
 * to a plugin, and the tests. Keeping the pair together is what makes the round
 * trip auditable — a path that maps to a filter must map back to itself.
 */

/** The Library's mount point inside the shell (`CORE_APPS` `skills-tools`). */
export const LIBRARY_ROOT = '/skills-and-tools';

/**
 * What the sidebar should show as selected for a path. `null` on the pages that
 * are not a filtered view of the catalog — the all-plugins index (the root, see
 * `isPluginsIndexPath`) and the item pages — where the gallery rows are all
 * inactive.
 *
 * `matchPath` hands params back RAW (react-router decodes neither here nor in
 * `useParams`), so a plugin named `Sales & Ops` arrives as `Sales%20%26%20Ops`
 * and has to be decoded to match the catalog's folder name. The plugin page owes
 * the same decode on `useParams().plugin`.
 */
export function libraryFilterForPath(pathname: string): LibraryFilter | null {
  if (matchPath({ path: `${LIBRARY_ROOT}/everything`, end: true }, pathname)) return { kind: 'all' };
  if (matchPath({ path: `${LIBRARY_ROOT}/owned`, end: true }, pathname)) return { kind: 'owned' };
  if (matchPath({ path: `${LIBRARY_ROOT}/yours`, end: true }, pathname)) return { kind: 'ungrouped' };
  const plugin = matchPath({ path: `${LIBRARY_ROOT}/plugins/:plugin`, end: true }, pathname);
  if (plugin?.params.plugin) return { kind: 'group', plugin: decodeSegment(plugin.params.plugin) };
  return null;
}

/** The path a sidebar selection navigates to. */
export function pathForLibraryFilter(filter: LibraryFilter): string {
  switch (filter.kind) {
    case 'all':
      return `${LIBRARY_ROOT}/everything`;
    case 'owned':
      return `${LIBRARY_ROOT}/owned`;
    case 'ungrouped':
      return `${LIBRARY_ROOT}/yours`;
    case 'group':
      return pathForPlugin(filter.plugin);
  }
}

/** The route for one plugin — member view or locked view, the page decides. */
export function pathForPlugin(plugin: string): string {
  return `${LIBRARY_ROOT}/plugins/${encodeURIComponent(plugin)}`;
}

/**
 * The all-plugins index — the Library's HOME. Plugins are the structure of this
 * surface, so the index of them is what the root shows; `plugins` is kept as a
 * redirect so the links that used to name it still land.
 */
export function pathForPluginsIndex(): string {
  return LIBRARY_ROOT;
}

/**
 * Read a `:plugin` route param. React-router 7 hands params back RAW from both
 * `matchPath` and `useParams`, so every reader owes this decode — and a
 * malformed escape (`%zz`, from a hand-edited or truncated link) THROWS, which
 * would blank the page. A bad link is a bad link, not a crash: fall back to the
 * raw segment and let the plugin simply not be found.
 */
export function decodePluginSegment(raw: string): string {
  return decodeSegment(raw);
}

/**
 * The CANONICAL URL of a library item: its workspace file URL on the default
 * branch — `/workspace/main/<kbDir>/<repo path>`. One URL system for humans
 * and agents: the address a card navigates to is the address an agent can
 * derive from the repo path it already works with, and the Knowledge tree's
 * link to the same file lands on the same page. `WorkspaceItemGate` is what
 * makes these URLs render the library surface instead of the raw file view.
 *
 * For a skill, pass the FILE inside the folder (`<skillPath>/SKILL.md`, a
 * reference doc, a script) — each file of a multi-file skill has its own URL,
 * and the page opens on that tab. A bare skill-folder URL opens SKILL.md.
 */
export function urlForItemFile(kbDirName: string, repoRelativePath: string): string {
  return kbFileUrl(DEFAULT_BRANCH, `${kbDirName}/${repoRelativePath}`);
}

/** The canonical URL of one file of a skill (default: its SKILL.md). */
export function urlForSkillFile(kbDirName: string, skillPath: string, file = 'SKILL.md'): string {
  return urlForItemFile(kbDirName, `${skillPath}/${file}`);
}

/**
 * The canonical URL of one MCP server declared in a plugin's `mcp.json`.
 *
 * One `mcp.json` declares SEVERAL servers, so the declaring file's URL alone
 * cannot name which tool page to open — the server's slug rides along as a
 * QUERY param (`?server=<slug>`). A query param and NOT the hash, deliberately:
 * the `#…` fragment on tool URLs is the OAuth callback's outcome channel
 * (`#authorized=…` / `#error=…` — see `pathForTool`), and the two must be able
 * to coexist on one URL.
 */
export function urlForMcpServer(kbDirName: string, mcpJsonPath: string, slug: string): string {
  return `${urlForItemFile(kbDirName, mcpJsonPath)}?server=${encodeURIComponent(slug)}`;
}

/**
 * Where a library item's card navigates — the ONE rule, shared by every
 * card-open site so a card does the same thing wherever it is clicked: the
 * item's canonical file URL, plus the `?server=` disambiguator when the item
 * is an mcp.json-declared server (whose declaring file is shared with its
 * sibling servers, so the file URL alone would not name it).
 */
export function urlForLibraryItem(
  kbDirName: string,
  item: { kind: 'skill' | 'integration'; id: string; path: string },
): string {
  return item.kind === 'integration' && item.path.endsWith('/mcp.json')
    ? urlForMcpServer(kbDirName, item.path, item.id)
    : urlForItemFile(kbDirName, item.path);
}

/**
 * Whether a location belongs to the LIBRARY surface — decided by URL SHAPE
 * alone, never by catalog contents: `/skills-and-tools/...`, or a
 * default-branch workspace URL under `Plugins/`
 * (`/workspace/<default>/<kbDir>/Plugins/<plugin>/...`). KnowledgeBase paths go
 * to the Knowledge surface, Plugins paths to Skills & Tools — the two roots ARE
 * the two apps. A shape rule means a just-created skill routes correctly
 * before any catalog has heard of it.
 *
 * Non-default branches stay with Knowledge deliberately: the library pages
 * speak the default branch, and a draft's file is reviewed raw.
 */
export function isLibraryLocation(pathname: string): boolean {
  if (pathname === LIBRARY_ROOT || pathname.startsWith(`${LIBRARY_ROOT}/`)) return true;
  const segments = pathname.split('/').filter(Boolean).map(decodeSegment);
  return (
    segments[0] === 'workspace' &&
    segments[1] === DEFAULT_BRANCH &&
    segments[3] === PLUGINS_DIR &&
    segments.length >= 6 // workspace/<branch>/<kbDir>/Plugins/<plugin>/<item>
  );
}

/**
 * The LEGACY route for one tool — now a redirect to the canonical workspace
 * URL (`urlForItemFile`), preserving any `#…` the OAuth callback appended.
 * Still built in three places, deliberately: the Secrets and Connect pages
 * link it by slug (they don't carry the repo path), and the tool page's own
 * OAuth `returnTo` MUST stay this shape — the server validates it.
 *
 * Returns the BARE path: never append `#…` to it. The OAuth start route rejects
 * a `returnTo` containing `#`, and the callback is what puts the fragment on.
 */
export function pathForTool(slug: string): string {
  return `${LIBRARY_ROOT}/tools/${encodeURIComponent(slug)}`;
}

/**
 * The LEGACY route for one skill — now a redirect to the canonical workspace
 * URL. Kept so old links and name-only callers still land; new code should
 * build `urlForSkillFile` from the catalog's path instead.
 */
export function pathForSkill(name: string): string {
  return `${LIBRARY_ROOT}/skills/${encodeURIComponent(name)}`;
}

/**
 * Whether a path is the all-plugins index — the one path that lights the "All
 * plugins" row. It is not a `LibraryFilter`: the index lists PLACES, not a
 * filtered slice of the catalog, which is why selection for it travels beside
 * the filter rather than inside it.
 *
 * `plugins` answers true as well even though it only ever redirects, so the row
 * is already lit while the redirect resolves.
 */
export function isPluginsIndexPath(pathname: string): boolean {
  return (
    matchPath({ path: LIBRARY_ROOT, end: true }, pathname) !== null ||
    matchPath({ path: `${LIBRARY_ROOT}/plugins`, end: true }, pathname) !== null
  );
}

/** A malformed escape is a bad link, not a crash — fall back to the raw segment. */
function decodeSegment(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * Where an item's back link points: the page the item LIVES on.
 *
 * `‹ All skills & tools` used to be the one answer, and it stopped being
 * true the day the Library's root became the all-plugins index — a skill
 * opened from its plugin page went "back" to a page the reader had never
 * been on. The honest destination is derivable from the path alone: the
 * plugin page for a grouped item, the personal page for a personal one, and
 * the root only for the legacy shapes that live in neither.
 */
export function libraryHomeForItemPath(repoRelativePath: string): {
  label: string;
  path: string;
} {
  const plugin = pluginOfPath(repoRelativePath);
  if (plugin !== null && !isPersonalPluginFolder(plugin)) {
    return { label: plugin, path: pathForPlugin(plugin) };
  }
  if (plugin !== null) {
    return { label: 'Yours', path: `${LIBRARY_ROOT}/yours` };
  }
  return { label: 'All skills & tools', path: LIBRARY_ROOT };
}
