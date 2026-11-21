import { useContext, useMemo, type ReactNode } from 'react';
import { Routes, Route } from 'react-router-dom';
import { FileExplorer, type GivenNode } from '../modules/workspace/components/FileExplorer';
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
 *
 * An app with screens of its own beside its folders keeps the one sidebar
 * with two more props. `nav` is its navigation, drawn above its folders in
 * the sidebar (see `FileExplorer`'s `lead`). `page` is the screen it shows
 * in place of the file viewer, at a location that is not a file: the surface
 * is then the sidebar and that page alone, without the registry's panes, so
 * no pane built around a file sits beside a page that is not one, and the
 * phone layout, which gives the screen to the chat pane, is not chosen for
 * it. Leave `page` out at a file's location and the viewer is back.
 * For both props, `undefined`, `null` and a boolean each mean "not given"
 * (see `given`), so `nav={cond && <Nav />}` and `page={onFile ? null : <Page />}`
 * do what they read as.
 * Both go into the pane list, so hand in the same element on every render
 * (one component each, which reads the location itself), as `roots` is one
 * array: a fresh element each time rebuilds the panes each time.
 */
export function KnowledgeSurface({
  roots,
  nav,
  page,
}: { roots?: readonly string[]; nav?: ReactNode; page?: ReactNode } = {}) {
  const registry = useAppRegistry();
  const setController = useContext(PaneControllerContext);
  const lead = given(nav);
  const shown = given(page);
  const panes = useMemo(() => {
    const onPage = shown !== undefined;
    const core = CORE_PANES.map((pane) => {
      if (pane.id === 'explorer') return { ...pane, node: <FileExplorer roots={roots} lead={lead} fileOnScreen={!onPage} /> };
      if (pane.id === 'viewer' && onPage) return { ...pane, node: shown };
      return pane;
    });
    return [...core, ...(onPage ? [] : registry.panes)].sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
  }, [registry, roots, lead, shown]);
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
 * The one rule for the surface's optional node props: `undefined`, `null`
 * and a boolean (what `cond && <X />` gives) are "not given", and come back
 * as `undefined`. Past this point only `undefined` means absent, and the
 * types hold the explorer to that: its `lead` is a `GivenNode`.
 */
function given(node: ReactNode): GivenNode | undefined {
  return node === undefined || node === null || typeof node === 'boolean' ? undefined : node;
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
