import { useContext, useMemo } from 'react';
import { Routes, Route } from 'react-router-dom';
import { FileExplorer } from '../modules/workspace/components/FileExplorer';
import { FileViewer } from '../modules/workspace/components/FileViewer';
import { FileRoute } from '../modules/workspace/components/FileRoute';
import { OpenChangeRequestsProvider } from '../modules/workspace/state/open-change-requests';
import { AppLayout } from '../modules/layout/components/AppLayout';
import { PaneControllerContext } from '../modules/layout/state/layout.context';
import { ConnectAgentPill } from '../modules/onboarding/components/ConnectAgentPill';
import { PullRequestsForMe } from '../modules/git/components/PullRequestsForMe';
import { useAppRegistry, type PaneDef } from './registry';

// Core panes; merged (by `order`) with registry-contributed panes (the
// enterprise chat pane registers at order 30). Sizing mirrors the historical
// hard-coded three-pane layout exactly. These are the KNOWLEDGE app's panes —
// other apps render their own full surface (see CORE_APPS).
const CORE_PANES: PaneDef[] = [
  // The file tree is the SIDEBAR, not a panel — the same frame, at the same
  // width, that Skills & Tools puts its plugin list in. It left the resizable
  // group when the two navs were unified; `SidebarFrame` owns its width and
  // the shared store owns whether it is showing.
  { id: 'explorer', order: 10, node: <FileExplorer />, sidebar: true, collapsible: true },
  { id: 'viewer', order: 20, node: <ViewerRoutes />, minSize: '30%' },
];

/**
 * The Knowledge app: the pane workspace (explorer / viewer / panes).
 *
 * With `roots`, the same surface narrowed to those top-level folders: the
 * folder surface an app mounts to show the roots it claims (see
 * `AppDef.roots`). Only the explorer changes, to those roots alone; the
 * viewer, the tab strip, the file operations, the renderers and the
 * proposed-file state are the Knowledge app's own. The Knowledge app is
 * mounted under the shell's change-request provider, which it shares with
 * the library; a narrowed surface is mounted by its app, outside it, so it
 * brings its own.
 */
export function KnowledgeSurface({ roots }: { roots?: readonly string[] } = {}) {
  const registry = useAppRegistry();
  const setController = useContext(PaneControllerContext);
  const panes = useMemo(
    () =>
      [
        ...(roots
          ? CORE_PANES.map((pane) =>
              pane.id === 'explorer' ? { ...pane, node: <FileExplorer roots={roots} /> } : pane,
            )
          : CORE_PANES),
        ...registry.panes,
      ].sort((a, b) => (a.order ?? 100) - (b.order ?? 100)),
    [registry, roots],
  );
  const layout = (
    /* The connect-your-agent reminder rides Knowledge's sidebar too, and
       the shell is where that is decided: `layout` is the app's generic
       consistency layer and must not name a domain component, so the pill
       is passed IN from the composition root. The Library passes the same
       one from `LibraryLayout` — one pill, both surfaces, so a person who
       skipped the welcome page and stayed in Knowledge still sees it. */
    <AppLayout
      panes={panes}
      onController={setController}
      sidebarHeader={<ConnectAgentPill />}
      // The change-request dock, pinned under the tree — and under the
      // Library's nav, which passes the same one: the requests waiting on
      // you are the same whichever app you are in.
      sidebarFooter={<PullRequestsForMe />}
    />
  );
  return roots ? <OpenChangeRequestsProvider>{layout}</OpenChangeRequestsProvider> : layout;
}

/**
 * The viewer pane: registry routes first, then the core routes. This
 * `<Routes>` block is nested inside the Knowledge surface's
 * `${KB_ROUTE_PREFIX}/*` route, so every path here matches the REMAINDER
 * after `/workspace` — `:branch/*` is `/workspace/<branch>/<path>` (the
 * absolute URLs `kbFileUrl()` builds), and the default `*` is the
 * knowledge-home fallback for `/workspace` itself.
 */
function ViewerRoutes() {
  const registry = useAppRegistry();
  return (
    <Routes>
      {registry.viewerRoutes.map((r) => (
        <Route key={r.path} path={r.path} element={r.element} />
      ))}
      <Route path=":branch/*" element={<FileRoute />} />
      <Route path="*" element={<FileViewer />} />
    </Routes>
  );
}
