import { useMemo, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { cn } from '../../../lib/utils';
import { DOCUMENT_COLUMN, documentGutters } from '../../../shared/theme/measure';
import { useAuth } from '../../auth/state/auth.context';
import { attentionOf, useLibrary } from '../state/library-data';
import { personalGroupName } from '../utils/personal-group';
import { libraryFilterForPath, pathForLibraryFilter } from '../routes/library-paths';
import { groupCounts } from '../utils/status';
import { useSidebar } from '../../layout/state/sidebar';
import { SidebarFrame } from '../../layout/components/SidebarFrame';
import { GroupsSidebar } from './GroupsSidebar';
import { NewGroupDialog } from './NewGroupDialog';

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
  const { items, groupSummaries, reload, reloadGroups } = useLibrary();
  const location = useLocation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [newGroupOpen, setNewGroupOpen] = useState(false);
  /**
   * Whether the nav is hidden. The state lives in a module store because the
   * button that flips it sits in the top bar, outside this layout's tree —
   * and because Knowledge's copy of this sidebar is the same object, not a
   * second one. See `layout/state/sidebar.ts`.
   */
  const { collapsed } = useSidebar();

  const filter = libraryFilterForPath(location.pathname);

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
      // A manager (canWrite via admin-rescue) is not locked out — their group
      // belongs with the ones they run, not below the gap.
      .filter((g) => !g.canRead && !g.canWrite && !visible.has(g.name))
      .map((g) => g.name)
      .sort((a, b) => a.localeCompare(b));
  }, [groupSummaries, items]);

  const ownedCount = useMemo(() => items.filter((i) => i.owned).length, [items]);
  /**
   * Owned items that are waiting on their owner. This — not `ownedCount` — is
   * what earns the amber badge: 26 things you own is a fact about your library,
   * one of them being broken is a fact about your afternoon.
   */
  const ownedAttention = useMemo(
    () => items.filter((i) => i.owned && i.status.state !== 'ok').length,
    [items],
  );
  const ungroupedCount = useMemo(() => items.filter((i) => i.group === null).length, [items]);
  const attentionCount = useMemo(
    () => items.filter((i) => i.kind === 'integration' && i.status.state !== 'ok').length,
    [items],
  );

  return (
    <div className="flex h-full min-h-0 bg-canvas text-ink">
      <SidebarFrame label="Library groups">
        <GroupsSidebar
          filter={filter}
          onSelect={(next) => navigate(pathForLibraryFilter(next))}
          groups={groups}
          lockedGroups={lockedGroups}
          ownedCount={ownedCount}
          ownedAttention={ownedAttention}
          personalGroupLabel={personalGroupName(user?.name)}
          ungroupedCount={ungroupedCount}
          attentionCount={attentionCount}
          onFinishSetup={() => navigate('/connect')}
          onCreateGroup={() => setNewGroupOpen(true)}
        />
      </SidebarFrame>

      {newGroupOpen && (
        <NewGroupDialog
          // Every name the workspace already knows, readable or not: creating
          // `Groups/GTM` when a locked `GTM` exists would not make a group, it
          // would drop items into somebody else's.
          existing={[...new Set([...groups.map((g) => g.group), ...groupSummaries.map((g) => g.name)])]}
          onClose={() => setNewGroupOpen(false)}
          onCreated={() => {
            reload();
            reloadGroups();
          }}
        />
      )}

      {/* The shared measure (`plans/05-knowledge-ui.md` D6). The pane stays the
          scroller so the scrollbar keeps sitting at its edge; the column
          inside it is the same 880px and the same side gutters Knowledge
          uses, so the two surfaces cannot report different widths at the same
          window width. Top padding is the one measure they deliberately do
          NOT share: Skills opens on a heading (34px), Knowledge on a tab
          strip (12px). */}
      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className={cn(DOCUMENT_COLUMN, documentGutters(collapsed), 'pt-[34px]')}>
          <Outlet />
        </div>
      </main>
    </div>
  );
}
