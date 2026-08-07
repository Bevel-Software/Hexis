import { DEFAULT_BRANCH, groupOfPath, isPersonalGroupFolder } from '@bevel-software/platform-shared';
import { matchPath } from 'react-router-dom';
import { kbFileUrl } from '../../workspace/routing/kb-routes';
import type { LibraryFilter } from '../utils/status';

/**
 * The Library's URL↔selection mapping, in one place and in both directions.
 *
 * Pure functions rather than logic inside the layout, because three surfaces
 * need them: the layout (to light the right sidebar row), every page that links
 * to a group, and the tests. Keeping the pair together is what makes the round
 * trip auditable — a path that maps to a filter must map back to itself.
 */

/** The Library's mount point inside the shell (`CORE_APPS` `skills-tools`). */
export const LIBRARY_ROOT = '/skills-and-tools';

/**
 * What the sidebar should show as selected for a path. `null` on the pages that
 * are not a filtered view of the catalog — the all-groups index (the root, see
 * `isGroupsIndexPath`) and the item pages — where the gallery rows are all
 * inactive.
 *
 * `matchPath` hands params back RAW (react-router decodes neither here nor in
 * `useParams`), so a group named `Sales & Ops` arrives as `Sales%20%26%20Ops`
 * and has to be decoded to match the catalog's folder name. The group page owes
 * the same decode on `useParams().group`.
 */
export function libraryFilterForPath(pathname: string): LibraryFilter | null {
  if (matchPath({ path: `${LIBRARY_ROOT}/everything`, end: true }, pathname)) return { kind: 'all' };
  if (matchPath({ path: `${LIBRARY_ROOT}/owned`, end: true }, pathname)) return { kind: 'owned' };
  if (matchPath({ path: `${LIBRARY_ROOT}/yours`, end: true }, pathname)) return { kind: 'ungrouped' };
  const group = matchPath({ path: `${LIBRARY_ROOT}/groups/:group`, end: true }, pathname);
  if (group?.params.group) return { kind: 'group', group: decodeSegment(group.params.group) };
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
      return pathForGroup(filter.group);
  }
}

/** The route for one group — member view or locked view, the page decides. */
export function pathForGroup(group: string): string {
  return `${LIBRARY_ROOT}/groups/${encodeURIComponent(group)}`;
}

/**
 * The all-groups index — the Library's HOME. Groups are the structure of this
 * surface, so the index of them is what the root shows; `groups` is kept as a
 * redirect so the links that used to name it still land.
 */
export function pathForGroupsIndex(): string {
  return LIBRARY_ROOT;
}

/**
 * Read a `:group` route param. React-router 7 hands params back RAW from both
 * `matchPath` and `useParams`, so every reader owes this decode — and a
 * malformed escape (`%zz`, from a hand-edited or truncated link) THROWS, which
 * would blank the page. A bad link is a bad link, not a crash: fall back to the
 * raw segment and let the group simply not be found.
 */
export function decodeGroupSegment(raw: string): string {
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
 * Whether a path is the all-groups index — the one path that lights the "All
 * groups" row. It is not a `LibraryFilter`: the index lists PLACES, not a
 * filtered slice of the catalog, which is why selection for it travels beside
 * the filter rather than inside it.
 *
 * `groups` answers true as well even though it only ever redirects, so the row
 * is already lit while the redirect resolves.
 */
export function isGroupsIndexPath(pathname: string): boolean {
  return (
    matchPath({ path: LIBRARY_ROOT, end: true }, pathname) !== null ||
    matchPath({ path: `${LIBRARY_ROOT}/groups`, end: true }, pathname) !== null
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
 * true the day the Library's root became the all-groups index — a skill
 * opened from its group page went "back" to a page the reader had never
 * been on. The honest destination is derivable from the path alone: the
 * group page for a grouped item, the personal page for a personal one, and
 * the root only for the legacy shapes that live in neither.
 */
export function libraryHomeForItemPath(repoRelativePath: string): {
  label: string;
  path: string;
} {
  const group = groupOfPath(repoRelativePath);
  if (group !== null && !isPersonalGroupFolder(group)) {
    return { label: group, path: pathForGroup(group) };
  }
  if (group !== null) {
    return { label: 'Yours', path: `${LIBRARY_ROOT}/yours` };
  }
  return { label: 'All skills & tools', path: LIBRARY_ROOT };
}
