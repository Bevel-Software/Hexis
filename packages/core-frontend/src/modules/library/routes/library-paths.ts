import { matchPath } from 'react-router-dom';
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
 * are not a filtered view of the catalog — the all-groups index, propose, and
 * the item pages — where the gallery rows are all inactive.
 *
 * `matchPath` hands params back RAW (react-router decodes neither here nor in
 * `useParams`), so a group named `Sales & Ops` arrives as `Sales%20%26%20Ops`
 * and has to be decoded to match the catalog's folder name. The group page owes
 * the same decode on `useParams().group`.
 */
export function libraryFilterForPath(pathname: string): LibraryFilter | null {
  if (matchPath({ path: LIBRARY_ROOT, end: true }, pathname)) return { kind: 'all' };
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
      return LIBRARY_ROOT;
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
 * Whether a path is the all-groups index or the propose page. Both light the
 * "All groups" row: you reached propose from the index, and the place you came
 * from should stay lit while you're there.
 */
export function isGroupsIndexPath(pathname: string): boolean {
  return (
    matchPath({ path: `${LIBRARY_ROOT}/groups`, end: true }, pathname) !== null ||
    matchPath({ path: `${LIBRARY_ROOT}/propose`, end: true }, pathname) !== null
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
