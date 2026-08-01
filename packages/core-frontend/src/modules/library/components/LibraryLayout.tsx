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
  const { items } = useLibrary();
  const location = useLocation();
  const navigate = useNavigate();

  const filter = libraryFilterForPath(location.pathname);
  const groupsIndexActive = isGroupsIndexPath(location.pathname);

  const groups = useMemo(
    () => groupCounts(items).map((g) => ({ ...g, attention: attentionOf(items, g.group) })),
    [items],
  );
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
        // WP7 (locked groups): `groupSummaries.filter(g => !g.canRead && the
        // catalog has no item in it).map(g => g.name)`. Empty until then, so no
        // locked section renders.
        lockedGroups={[]}
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
