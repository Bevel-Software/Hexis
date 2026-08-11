import { useCallback, useMemo, useRef, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { cn } from '../../../lib/utils';
import { DOCUMENT_COLUMN, documentGutters } from '../../../shared/theme/measure';
import { useAuth } from '../../auth/state/auth.context';
import { useAdmin } from '../../admin/state/admin.context';
import { attentionOf, useLibrary, workspaceHasNoGroups } from '../state/library-data';
import { personalGroupName } from '../utils/personal-group';
import {
  isGroupsIndexPath,
  libraryFilterForPath,
  pathForGroupsIndex,
  pathForLibraryFilter,
} from '../routes/library-paths';
import { groupCounts, type LibraryFilter } from '../utils/status';
import { primaryFolderOf } from '../utils/group-summary';
import { LINK_COPIED_TOAST, LINK_COPY_FAILED_TOAST, copyToClipboard } from '../utils/clipboard';
import { useLibraryToast } from '../state/toast.context';
import { useSidebar } from '../../layout/state/sidebar';
import { SidebarFrame } from '../../layout/components/SidebarFrame';
import { useWorkspace } from '../../workspace/state/workspace.context';
import { ManageAccessDialog } from '../../access/components/ManageAccessDialog';
import { ConnectAgentPill } from '../../onboarding/components/ConnectAgentPill';
import { GroupsSidebar, type SidebarContextTarget } from './GroupsSidebar';
import { GroupsSidebarMenu } from './GroupsSidebarMenu';
import { AddToGroupDialog } from './AddToGroupDialog';
import { DeleteGroupDialog } from './DeleteGroupDialog';
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
  const lib = useLibrary();
  const { items, groupSummaries, reload, reloadGroups } = lib;
  const location = useLocation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { isAdmin } = useAdmin();
  const { kbDirName } = useWorkspace();
  const toast = useLibraryToast();
  const [newGroupOpen, setNewGroupOpen] = useState(false);
  /**
   * The sidebar's right-click menu, and the two sheets it can open. All three
   * live HERE rather than in `GroupsSidebar` because the verbs need the group
   * summaries and the workspace's KB dir — the sidebar is handed a list of
   * names and counts and knows neither. The sidebar reports the click; this
   * decides what is true about what was clicked.
   */
  const [menu, setMenu] = useState<SidebarContextTarget | null>(null);
  /**
   * Captured whole at pick time, not looked up at render time: the menu closes
   * as it hands over, so by the time the dialog paints there is no `menu` left
   * to re-derive the group from.
   */
  const [addTo, setAddTo] = useState<{
    name: string;
    primaryPath: string;
    canWrite: boolean;
  } | null>(null);
  const [manageFolder, setManageFolder] = useState<string | null>(null);
  /**
   * The group whose delete confirmation is up — captured whole at pick time
   * for the same reason `addTo` is: the menu is gone by the time the dialog
   * paints, and the counts belong in the dialog's copy.
   */
  const [deleting, setDeleting] = useState<{
    name: string;
    skillCount: number;
    toolCount: number;
  } | null>(null);
  /**
   * The row the open menu came from. A ref, not state, because
   * `useDismissableMenu` wants a stable `RefObject` to return focus INTO on
   * Escape — re-rendering the menu to tell it about the row would defeat the
   * point.
   */
  const menuRow = useRef<HTMLElement | null>(null);
  /**
   * Whether the nav is hidden. The state lives in a module store because the
   * button that flips it sits in the top bar, outside this layout's tree —
   * and because Knowledge's copy of this sidebar is the same object, not a
   * second one. See `layout/state/sidebar.ts`.
   */
  const { collapsed } = useSidebar();

  const filter = libraryFilterForPath(location.pathname);

  /**
   * The member rows: every group the caller can READ (or manages), whether or
   * not anything is in it yet. Counts come from the catalog, membership does
   * not — a freshly created group has no skills or tools, and deriving the
   * rows from the items alone made it vanish from the very nav that says
   * "Included in your MCP". Being in a group is what puts it in your MCP;
   * having content is not. The catalog still contributes names the summaries
   * miss (a per-file grant can surface one skill from an otherwise unreadable
   * folder), so the two witnesses are merged rather than either winning.
   */
  const groups = useMemo(() => {
    const counts = new Map(groupCounts(items).map((g) => [g.group, g.count]));
    const names = new Set<string>(counts.keys());
    for (const g of groupSummaries) {
      if (g.canRead || g.canWrite) names.add(g.name);
    }
    return [...names]
      .sort((a, b) => a.localeCompare(b))
      .map((group) => ({
        group,
        count: counts.get(group) ?? 0,
        attention: attentionOf(items, group),
      }));
  }, [items, groupSummaries]);
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

  /**
   * What the open menu is pointing at.
   *
   * A group row resolves to its summary, which is where the folder behind it
   * lives — and therefore whether `Add a skill or tool` and `Manage access`
   * have anything to act on at all. A LENS row resolves to nothing, because
   * neither lens is a folder: "Owned by me" and your own space are slices of
   * the catalog, and there is no `access.md` behind a slice. That is the same
   * call the group page's `PageActions` already makes when it hides `Share` on
   * the personal page, and the menu has to make it the same way or the two
   * surfaces disagree about what a lens is.
   *
   * `Manage access` stays UNGATED on `canWrite`, exactly as `Share` is: for a
   * non-writer the dialog renders read-only, which is precisely what "who is
   * this shared with?" should answer.
   */
  const menuFilter = menu?.filter ?? null;
  const menuGroup = menuFilter?.kind === 'group' ? menuFilter.group : null;
  const menuSummary = useMemo(
    () => (menuGroup ? groupSummaries.find((g) => g.name === menuGroup) : undefined),
    [groupSummaries, menuGroup],
  );
  const menuFolder = menuSummary ? primaryFolderOf(menuSummary) : null;

  const openContextMenu = useCallback((target: SidebarContextTarget) => {
    menuRow.current = target.row;
    setMenu(target);
  }, []);

  /**
   * A link to a row's page — origin + the row's own route, so it is the URL
   * that row navigates to and not the one you happen to be standing on. The
   * clipboard can refuse outright (a non-secure origin, an unfocused document),
   * and a silent no-op is the worst possible answer to "copy this" — so the
   * toast tells the truth either way.
   */
  const copyLink = useCallback(
    async (target: LibraryFilter) => {
      const ok = await copyToClipboard(`${window.location.origin}${pathForLibraryFilter(target)}`);
      toast(ok ? LINK_COPIED_TOAST : LINK_COPY_FAILED_TOAST, ok ? 'neutral' : 'danger');
    },
    [toast],
  );

  return (
    <div className="flex h-full min-h-0 bg-canvas text-ink">
      {/* The connect-your-agent CTA sits above the group list — the one row
          that has to be true before the rows under it mean anything. Passed
          IN rather than mounted by the frame: which reminder belongs at the
          top of this nav is the surface's call, and `SidebarFrame` is the
          app's generic consistency layer. Knowledge passes the same pill from
          `ResizableThreePaneLayout`, which is what keeps it one pill in one
          place — a person who skipped the welcome page and stayed in
          Knowledge still sees it. It renders nothing once onboarding is
          done. */}
      <SidebarFrame label="Library groups" header={<ConnectAgentPill />}>
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
          // The whole verdict, not just the role: the create-a-group row is a
          // claim that the workspace holds no groups AT ALL, and that claim is
          // only honest once both group witnesses have settled successfully —
          // while they load (or after they fail) an empty list is an unanswered
          // question, not an untouched workspace.
          canCreateGroup={isAdmin && workspaceHasNoGroups(lib)}
          groupsIndexActive={isGroupsIndexPath(location.pathname)}
          onOpenGroupsIndex={() => navigate(pathForGroupsIndex())}
          onContextMenu={openContextMenu}
        />
      </SidebarFrame>

      {/* The nav's right-click menu — Knowledge's file tree has had one since it
          shipped, and two sidebars in one app should not answer the same
          gesture two different ways. Rendered HERE, outside the frame, because
          it is fixed to the pointer rather than laid out in the column. */}
      {menu && (
        <GroupsSidebarMenu
          x={menu.x}
          y={menu.y}
          label={menu.label}
          onClose={() => setMenu(null)}
          onAdd={
            menuGroup && menuFolder && menuSummary
              ? () =>
                  setAddTo({
                    name: menuGroup,
                    primaryPath: menuFolder,
                    canWrite: menuSummary.canWrite,
                  })
              : undefined
          }
          onCreateGroup={() => setNewGroupOpen(true)}
          onCopyLink={menuFilter ? () => void copyLink(menuFilter) : undefined}
          onManageAccess={menuFolder && kbDirName ? () => setManageFolder(menuFolder) : undefined}
          // The OWNER's verb, and only theirs — `isOwner` is the same verdict
          // the DELETE route enforces, so the affordance appears for exactly
          // the people the backend will let through.
          onDelete={
            menuSummary?.isOwner
              ? () =>
                  setDeleting({
                    name: menuSummary.name,
                    skillCount: menuSummary.skillCount,
                    toolCount: menuSummary.toolCount,
                  })
              : undefined
          }
          returnFocusTo={menuRow}
        />
      )}

      {addTo && (
        <AddToGroupDialog
          name={addTo.name}
          primaryPath={addTo.primaryPath}
          canWrite={addTo.canWrite}
          // Every skill, not just this group's: a skill's id is its name and
          // ids are global, so that is the collision the create half must catch.
          existingSkills={items.filter((i) => i.kind === 'skill').map((i) => i.name)}
          onClose={() => setAddTo(null)}
        />
      )}

      {manageFolder && kbDirName && (
        <ManageAccessDialog
          entry={{
            name: manageFolder.split('/').pop() ?? manageFolder,
            relativePath: `${kbDirName}/${manageFolder}`,
            type: 'directory',
          }}
          onClose={() => {
            setManageFolder(null);
            // Granting through the dialog can settle a pending join request —
            // refresh the roster and the catalog together, exactly as the group
            // page does when its copy of this dialog closes.
            reloadGroups();
            reload();
          }}
        />
      )}

      {deleting && (
        <DeleteGroupDialog
          name={deleting.name}
          skillCount={deleting.skillCount}
          toolCount={deleting.toolCount}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            toast(`Deleted ${deleting.name}.`);
            // Standing inside the group that just ceased to exist would
            // render "This group doesn't exist yet" — the index is the
            // honest place to land. Any other page is unaffected.
            if (filter?.kind === 'group' && filter.group === deleting.name) {
              navigate(pathForGroupsIndex());
            }
            reload();
            reloadGroups();
          }}
        />
      )}

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
