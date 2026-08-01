import { useMemo } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { attentionOf, useLibrary } from '../state/library-data';
import {
  LIBRARY_ROOT,
  isGroupsIndexPath,
  libraryFilterForPath,
  pathForLibraryFilter,
} from '../routes/library-paths';
import { groupCounts } from '../utils/status';
import { GroupsSidebar } from './GroupsSidebar';

/**
 * The shell every Library page renders inside: the group nav on the left, the
 * page in the scrolling column on the right.
 *
 * It is also the ONE place the URL and the sidebar meet — the path becomes a
 * `LibraryFilter` on the way in, a click becomes a `navigate` on the way out.
 * Nothing else in the Library knows either mapping, which is why the gallery
 * can take its filter as a plain prop and the sidebar can hold no state.
 */
export function LibraryLayout() {
  const { items, groupSummaries } = useLibrary();
  const location = useLocation();
  const navigate = useNavigate();

  const filter = libraryFilterForPath(location.pathname);
  const groupsIndexActive = isGroupsIndexPath(location.pathname);

  const groups = useMemo(
    () => groupCounts(items).map((g) => ({ ...g, attention: attentionOf(items, g.group) })),
    [items],
  );
  /**
   * Groups the caller cannot get into, alphabetical.
   *
   * `canRead` is the folder verdict; the catalog is the other witness, and it
   * wins when it disagrees. Access resolves closeness-first, so a per-file grant
   * can hand somebody one skill inside a folder they cannot read — showing that
   * group locked while its skill sits in the gallery above would be the Library
   * contradicting itself. Same rule as `GroupPage`'s member-vs-locked decision,
   * which is what keeps the row and the page it opens in agreement.
   */
  const lockedGroups = useMemo(() => {
    const visible = new Set(items.map((i) => i.group).filter((g): g is string => g !== null));
    return groupSummaries
      .filter((g) => !g.canRead && !visible.has(g.name))
      .map((g) => g.name)
      .sort((a, b) => a.localeCompare(b));
  }, [groupSummaries, items]);

  const ownedCount = useMemo(() => items.filter((i) => i.owned).length, [items]);
  const ungroupedCount = useMemo(() => items.filter((i) => i.group === null).length, [items]);
  const attentionCount = useMemo(
    () => items.filter((i) => i.kind === 'integration' && i.status.state !== 'ok').length,
    [items],
  );

  return (
    <div className="flex h-full min-h-0 bg-canvas text-ink">
      <GroupsSidebar
        filter={filter}
        onSelect={(next) => navigate(pathForLibraryFilter(next))}
        groups={groups}
        lockedGroups={lockedGroups}
        groupsIndexActive={groupsIndexActive}
        onOpenGroupsIndex={() => navigate(`${LIBRARY_ROOT}/groups`)}
        ownedCount={ownedCount}
        ungroupedCount={ungroupedCount}
        attentionCount={attentionCount}
        onFinishSetup={() => navigate('/connect')}
      />

      <main className="min-w-0 flex-1 overflow-y-auto px-8 py-6">
        <Outlet />
      </main>
    </div>
  );
}
