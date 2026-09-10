import { useCallback, useMemo, useRef, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { isPersonalPluginFolder } from '@bevel-software/platform-shared';
import { cn } from '../../../lib/utils';
import { DOCUMENT_COLUMN, documentGutters } from '../../../shared/theme/measure';
import { useAdmin } from '../../admin/state/admin.context';
import { attentionOf, useLibrary, workspaceHasNoPlugins } from '../state/library-data';
import { personalPluginName } from '../utils/personal-plugin';
import { libraryFilterForPath, pathForLibraryFilter } from '../routes/library-paths';
import { filterLibraryItems, pluginsOfItem, type LibraryFilter } from '../utils/status';
import { pluginEntriesFor } from '../utils/plugin-entries';
import { LINK_COPIED_TOAST, LINK_COPY_FAILED_TOAST, copyToClipboard } from '../utils/clipboard';
import { useLibraryToast } from '../state/toast.context';
import { useSidebar } from '../../layout/state/sidebar';
import { SidebarFrame } from '../../layout/components/SidebarFrame';
import { ConnectAgentPill } from '../../onboarding/components/ConnectAgentPill';
import { PullRequestsForMe } from '../../git/components/PullRequestsForMe';
import { PluginsSidebar, type SidebarContextTarget } from './PluginsSidebar';
import { PluginsTree, SkillsTree } from './SkillsTree';
import { PluginsSidebarMenu } from './PluginsSidebarMenu';
import { NewPluginDialog } from './NewPluginDialog';

/**
 * The shell every Library page renders inside: the nav on the left, the page
 * in the scrolling column on the right.
 *
 * It is also the ONE place the URL and the sidebar meet — the path becomes a
 * `LibraryFilter` on the way in, a click becomes a `navigate` on the way out.
 * Nothing else in the Library knows either mapping, which is why the gallery
 * can take its filter as a plain prop and the sidebar can hold no state.
 *
 * The nav lists LENSES and PLACES, never individual plugins: Everything and
 * Owned by me, then the groups (Everyone first), then the two roots as file
 * trees. A plugin — the caller's own space included — is reached through the
 * page it is on: its row on Everything or a team's page, its folder in the
 * Plugins tree. So the
 * plugin verbs (add to, manage access, delete) live on the plugin page and
 * the tree row, and the nav's own menu keeps only what the nav can answer:
 * a link to the row, and a new plugin.
 */
export function LibraryLayout() {
  const lib = useLibrary();
  const { items, pluginSummaries, teams, reload, reloadPlugins } = lib;
  const location = useLocation();
  const navigate = useNavigate();
  const { isAdmin } = useAdmin();
  const toast = useLibraryToast();
  /**
   * The New plugin dialog, with WHERE the plugin goes: `''` is the plugins
   * root (the nav's own verbs), a path below it is the grouping folder a
   * person right-clicked in the Plugins tree.
   */
  const [newPlugin, setNewPlugin] = useState<{ parent: string } | null>(null);
  const [menu, setMenu] = useState<SidebarContextTarget | null>(null);
  const menuRow = useRef<HTMLElement | null>(null);
  const { collapsed } = useSidebar();

  const filter = libraryFilterForPath(location.pathname);
  const personalLabel = personalPluginName();

  /**
   * One row per team: how much of the catalog the team can use, and — in
   * orange, outranking the count — how many of its plugins' links lock its
   * members out of a skill right now. The count is what the team's page will
   * list: its plugin rows plus its cards, from the same two slices.
   */
  const teamRows = useMemo(
    () =>
      teams.map((team) => {
        const teamFilter: LibraryFilter = { kind: 'team', group: team.name };
        const plugins = pluginEntriesFor(items, pluginSummaries, teamFilter, teams, '', personalLabel);
        const cards = filterLibraryItems(items, teamFilter, '', teams);
        const urgent = plugins.reduce(
          (n, p) => n + (p.name === null ? 0 : attentionOf(items, p.name, pluginSummaries).brokenLinks),
          0,
        );
        return { name: team.name, count: plugins.length + cards.length, urgent };
      }),
    [teams, items, pluginSummaries, personalLabel],
  );
  const ownedCount = useMemo(
    () =>
      items.filter((i) => i.owned).length +
      pluginEntriesFor(items, pluginSummaries, { kind: 'owned' }, teams, '', personalLabel).length,
    [items, pluginSummaries, teams, personalLabel],
  );
  const ownedAttention = useMemo(
    () => items.filter((i) => i.owned && i.status.state !== 'ok').length,
    [items],
  );
  const attentionCount = useMemo(
    () => items.filter((i) => i.kind === 'integration' && i.status.state !== 'ok').length,
    [items],
  );
  const existingPlugins = useMemo(
    () => [...new Set([...items.flatMap((i) => pluginsOfItem(i)), ...pluginSummaries.map((g) => g.name)])],
    [items, pluginSummaries],
  );

  const openContextMenu = useCallback((target: SidebarContextTarget) => {
    menuRow.current = target.row;
    setMenu(target);
  }, []);

  const copyLink = useCallback(
    async (target: LibraryFilter) => {
      const ok = await copyToClipboard(`${window.location.origin}${pathForLibraryFilter(target)}`);
      toast(ok ? LINK_COPIED_TOAST : LINK_COPY_FAILED_TOAST, ok ? 'neutral' : 'danger');
    },
    [toast],
  );

  return (
    <div className="flex h-full min-h-0 bg-canvas text-ink">
      {/* The connect-your-agent CTA sits above the nav — the one row that has
          to be true before the rows under it mean anything. Passed IN rather
          than mounted by the frame: which reminder belongs at the top of this
          nav is the surface's call, and `SidebarFrame` is the app's generic
          consistency layer. Knowledge passes the same pill from
          `ResizableThreePaneLayout`, which is what keeps it one pill in one
          place — a person who skipped the welcome page and stayed in
          Knowledge still sees it. It renders nothing once onboarding is
          done. The change-request dock below the nav is the same one
          Knowledge pins under its tree — the requests waiting on you are
          the same whichever app you are in. */}
      <SidebarFrame label="Library navigation" header={<ConnectAgentPill />} footer={<PullRequestsForMe />}>
        <PluginsSidebar
          filter={filter}
          onSelect={(next) => navigate(pathForLibraryFilter(next))}
          ownedCount={ownedCount}
          ownedAttention={ownedAttention}
          teams={teamRows}
          attentionCount={attentionCount}
          onFinishSetup={() => navigate('/connect')}
          onCreatePlugin={() => setNewPlugin({ parent: '' })}
          canCreatePlugin={isAdmin && workspaceHasNoPlugins(lib)}
          onContextMenu={openContextMenu}
          skillsTree={<SkillsTree />}
          pluginsTree={
            <PluginsTree
              onCreatePlugin={(parent) => setNewPlugin({ parent })}
              // A plugin cannot hold another: the verb is offered on grouping
              // folders only — the root and folders no listed plugin owns.
              // Closed until the plugin list has loaded: an unknown list is
              // not an empty one. Personal spaces are named by the same rule
              // the endpoint refuses them by — the first segment below the
              // root carries the personal prefix — so the tree never offers a
              // parent the endpoint will not take.
              isGroupingFolder={(rel) => {
                if (lib.pluginsLoading || lib.pluginsError) return false;
                const below = rel.split('/');
                if (below.length >= 2 && isPersonalPluginFolder(below[1]!)) return false;
                return !pluginSummaries.some((s) => s.folders.some((f) => rel === f || rel.startsWith(`${f}/`)));
              }}
            />
          }
        />
      </SidebarFrame>
      {/* The nav's right-click menu — Knowledge's file tree has had one since it
          shipped, and two sidebars in one app should not answer the same
          gesture two different ways. Rendered HERE, outside the frame, because
          it is fixed to the pointer rather than laid out in the column. */}
      {menu && (
        <PluginsSidebarMenu
          x={menu.x}
          y={menu.y}
          label={menu.label}
          onClose={() => setMenu(null)}
          onCreatePlugin={() => setNewPlugin({ parent: '' })}
          onCopyLink={menu.filter ? () => void copyLink(menu.filter!) : undefined}
          returnFocusTo={menuRow}
        />
      )}
      {newPlugin && (
        <NewPluginDialog
          existing={existingPlugins}
          parent={newPlugin.parent}
          onClose={() => setNewPlugin(null)}
          onCreated={() => {
            reload();
            reloadPlugins();
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
