import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  Fragment,
  type ReactNode,
} from 'react';
import { BrowserRouter, Navigate, Routes, Route, useLocation } from 'react-router-dom';
import { AuthContext } from '../modules/auth/state/auth.context';
import { useAuthState } from '../modules/auth/hooks/useAuthState';
import { LoginScreen } from '../modules/auth/components/LoginScreen';
import { WorkspaceContext } from '../modules/workspace/state/workspace.context';
import { useWorkspaceState } from '../modules/workspace/hooks/useWorkspaceState';
import { GitContext } from '../modules/git/state/git.context';
import { AutoUpdateContext } from '../modules/git/state/auto-update.context';
import { useGitState } from '../modules/git/hooks/useGitState';
import { useAutoPullUpdates } from '../modules/git/hooks/useAutoPullUpdates';
import { PrViewerContext } from '../modules/pr/state/pr-viewer.context';
import { usePrViewerState } from '../modules/pr/hooks/usePrViewerState';
import { EventBusProvider } from '../modules/workflow/state/EventBusProvider';
import { EventBusFocusBinder } from '../modules/workflow/state/EventBusFocusBinder';
import { Toolbar } from '../modules/toolbar/components/Toolbar';
import { DemoBanner } from '../modules/layout/components/DemoBanner';
import { FileExplorer } from '../modules/workspace/components/FileExplorer';
import { FileViewer } from '../modules/workspace/components/FileViewer';
import { OpenChangeRequestsProvider } from '../modules/workspace/state/open-change-requests';
import { FileRoute } from '../modules/workspace/components/FileRoute';
import { KB_ROUTE_PREFIX } from '../modules/workspace/routing/kb-routes';
import { AppLayout } from '../modules/layout/components/AppLayout';
import {
  LayoutContext,
  NO_PANES_LAYOUT,
  type LayoutController,
} from '../modules/layout/state/layout.context';
import { MaintenanceOverlay } from '../modules/layout/components/MaintenanceOverlay';
import { AdminProvider } from '../modules/admin/state/admin.context';
import { RolesCorruptedBanner } from '../modules/admin/components/RolesCorruptedBanner';
import { ReviewProvider } from '../modules/review/state/ReviewProvider';
import { ReviewPanelSurface } from '../modules/review/components/ReviewPanelSurface';
import { ConnectToolsPage } from '../modules/secrets-vault/components/ConnectToolsPage';
import { SecretsPage } from '../modules/secrets-vault/components/SecretsPage';
import { AccountPage } from '../modules/auth/components/AccountPage';
import { ExternalAgentAccessPage } from '../modules/toolbar/components/ExternalAgentAccessPage';
import { AdminRolesPage } from '../modules/admin/components/AdminRolesPage';
import { UserAccountsPage } from '../modules/admin/components/UserAccountsPage';
import { ToolsExplorerPage } from '../modules/tools/ToolsExplorerPage';
import { LibraryRoutes } from '../modules/library/routes/LibraryRoutes';
import { RootLanding } from '../modules/onboarding/components/RootLanding';
import { ConnectAgentPill } from '../modules/onboarding/components/ConnectAgentPill';
import { OpenChangeRequestDialog } from '../modules/pr/components/OpenChangeRequestDialog';
import { useMediaQuery } from '../modules/layout/hooks/useMediaQuery';
import { NARROW_QUERY } from '../modules/layout/breakpoints';
import { setSidebarCollapsed } from '../modules/layout/state/sidebar';
import {
  activeAppId,
  ActiveAppIdContext,
  AppRegistryContext,
  CrCreationPortContext,
  SuggestedPromptSeedContext,
  useAppRegistry,
  type AppDef,
  type AppRegistry,
  type BannerDef,
  type CrCreationInput,
  type CrCreationPort,
  type PaneDef,
} from './registry';

/**
 * The registry-driven application shell for the core modules (workspace, git,
 * pr, access, auth, workflow/SSE, layout, secrets-vault, tools, toolbar,
 * library, review — the UI of the core diff backend — and the admin roles
 * page). Everything else — chat, connectors, routines, watchlist, voice,
 * embed, onboarding, admin LLM/feedback pages — is contributed through the
 * {@link AppRegistry} passed in (see `src/enterprise-registry.tsx` for the
 * current enterprise composition).
 */

/**
 * Outer authenticated shell. Mounts `EventBusProvider` BEFORE any state
 * hook so the hooks below can subscribe to the SSE bus via `useEventBus()`.
 *
 * Why this split exists: `useWorkspaceState`, `useReviewState`, etc. each
 * call `useEventBus()` and register subscriptions in a `useEffect`. The
 * subscription bails when `bus === null`. If these hooks ran in the same
 * component that *returns* `<EventBusProvider>`, they'd execute before
 * the provider is mounted in the React tree — so `useContext(EventBusContext)`
 * would return the default `null` and the subscriptions would silently
 * drop on the floor (the symptom: events fire, `handlerCount: 0` in the
 * dispatch log, and the file-changed live-refresh never wires up). Putting
 * the provider above the state hooks fixes the ordering. (This also covers
 * registry-provided state wrappers like the enterprise ReviewProvider —
 * they render inside `AuthenticatedAppInner`, i.e. under the bus.)
 */
function AuthenticatedApp() {
  return (
    <EventBusProvider>
      <AuthenticatedAppInner />
    </EventBusProvider>
  );
}

function AuthenticatedAppInner() {
  const registry = useAppRegistry();
  const workspaceState = useWorkspaceState();
  const gitState = useGitState(workspaceState.workspaceId);
  const autoUpdateState = useAutoPullUpdates(gitState, workspaceState);
  const prViewerState = usePrViewerState();

  // Refresh git status whenever the user accepts/rejects pending content, since that
  // is the moment new bytes hit the working tree.
  const { pendingFileContent, fsRevision } = workspaceState;
  const { refreshStatus } = gitState;
  useEffect(() => {
    if (pendingFileContent === null) {
      refreshStatus();
    }
  }, [pendingFileContent, refreshStatus]);

  // Same idea for direct FS mutations (create, delete, rename, upload, save) — the
  // 30s status poll in useGitState would otherwise leave the Share Changes button
  // stale until the next tick. Skip the initial mount (fsRevision === 0) since the
  // effect above already covers the first-load refresh.
  useEffect(() => {
    if (fsRevision > 0) refreshStatus();
  }, [fsRevision, refreshStatus]);

  // Registry-provided wrappers (chat, onboarding-import, agent ports, …)
  // apply INSIDE the core providers below — so they can read workspace/git
  // state — but OUTSIDE the layout, so every pane (including registered ones)
  // sees them. `providers[0]` ends up outermost. ReviewProvider is CORE (the
  // UI of the core diff/pending-changes backend) and sits innermost — the
  // same slot it occupied when it was registry-provided.
  const chrome = registry.providers.reduceRight<ReactNode>(
    (children, wrap) => wrap(children),
    <ReviewProvider>
      <AppChrome />
    </ReviewProvider>,
  );

  return (
    <WorkspaceContext.Provider value={workspaceState}>
      <EventBusFocusBinder />
      <GitContext.Provider value={gitState}>
        <AutoUpdateContext.Provider value={autoUpdateState}>
          <PrViewerContext.Provider value={prViewerState}>
            <AdminProvider>
              <CrCreationHost>{chrome}</CrCreationHost>
            </AdminProvider>
          </PrViewerContext.Provider>
        </AutoUpdateContext.Provider>
      </GitContext.Provider>
    </WorkspaceContext.Provider>
  );
}

// Core banner strip entries; merged (by `order`) with registry-contributed
// banners in AppChrome. The enterprise registry slots its CrDeepLink before
// and its onboarding-import banner after these.
const CORE_BANNERS: BannerDef[] = [
  { id: 'demo', order: 20, node: <DemoBanner /> },
  { id: 'roles-corrupted', order: 30, node: <RolesCorruptedBanner /> },
];

// Core panes; merged (by `order`) with registry-contributed panes (the
// enterprise chat pane registers at order 30). Sizing mirrors the historical
// hard-coded three-pane layout exactly. These are the KNOWLEDGE app's panes —
// other apps render their own full surface (see CORE_APPS).
const CORE_PANES: PaneDef[] = [
  // The file tree is the SIDEBAR, not a panel — the same frame, at the same
  // width, that Skills & Tools puts its group list in. It left the resizable
  // group when the two navs were unified; `SidebarFrame` owns its width and
  // the shared store owns whether it is showing.
  { id: 'explorer', order: 10, node: <FileExplorer />, sidebar: true, collapsible: true },
  { id: 'viewer', order: 20, node: <ViewerRoutes />, minSize: '30%' },
];

/**
 * The core apps behind the toolbar's app switcher. Each app is a full
 * surface below the always-mounted toolbar. "Skills & Tools" mounts
 * `LibraryRoutes`, which owns its own nested route table (gallery, groups,
 * items) below this path. Knowledge's path IS `KB_ROUTE_PREFIX` ('/workspace') — the KB file
 * links `kbFileUrl()` produces are absolute `/workspace/<branch>/<path>`
 * URLs, so they land inside the Knowledge surface by construction.
 */
const CORE_APPS: AppDef[] = [
  {
    id: 'knowledge',
    label: 'Knowledge',
    path: KB_ROUTE_PREFIX,
    description: 'Browse and edit your knowledge base',
    order: 10,
    element: <KnowledgeSurface />,
  },
  {
    id: 'skills-tools',
    label: 'Skills & Tools',
    path: '/skills-and-tools',
    description: 'What your assistant can do, and what it connects to',
    order: 20,
    element: <LibraryRoutes />,
  },
];

/**
 * Setter through which the Knowledge surface's pane layout reports its
 * controller to AppChrome (whose LayoutContext provider wraps the toolbar).
 */
const PaneControllerContext = createContext<(c: LayoutController | null) => void>(
  () => {},
);

/** The Knowledge app: the historical pane workspace (explorer / viewer / panes). */
function KnowledgeSurface() {
  const registry = useAppRegistry();
  const setController = useContext(PaneControllerContext);
  const panes = useMemo(
    () =>
      [...CORE_PANES, ...registry.panes].sort(
        (a, b) => (a.order ?? 100) - (b.order ?? 100),
      ),
    [registry],
  );
  // Mounted here, once, because three separate subtrees ask the same question:
  // the tree (per row), the tab strip (per tab) and the viewer's banner. A
  // plain hook per consumer would give every tree row its own request.
  return (
    <OpenChangeRequestsProvider>
      {/* The connect-your-agent reminder rides Knowledge's sidebar too, and
          the shell is where that is decided: `layout` is the app's generic
          consistency layer and must not name a domain component, so the pill
          is passed IN from the composition root. The Library passes the same
          one from `LibraryLayout` — one pill, both surfaces, so a person who
          skipped the welcome page and stayed in Knowledge still sees it. */}
      <AppLayout
        panes={panes}
        onController={setController}
        sidebarHeader={<ConnectAgentPill />}
      />
    </OpenChangeRequestsProvider>
  );
}

export function AppChrome() {
  const registry = useAppRegistry();
  const location = useLocation();
  const narrow = useMediaQuery(NARROW_QUERY);
  const banners = useMemo(
    () =>
      [...CORE_BANNERS, ...registry.banners].sort(
        (a, b) => (a.order ?? 100) - (b.order ?? 100),
      ),
    [registry],
  );
  // The full app list (core apps were merged into the registry by the shell).
  const apps = useMemo(
    () => [...registry.apps].sort((a, b) => (a.order ?? 100) - (b.order ?? 100)),
    [registry],
  );
  const activeId = activeAppId(apps, location.pathname);

  // A narrow sidebar can be opened from the toolbar, but it must not cover
  // the destination after the user chooses a group or file inside it.
  useEffect(() => {
    if (narrow) setSidebarCollapsed(true);
  }, [location.pathname, narrow]);

  // Pane controller bridge: the toolbar sits OUTSIDE the active app's surface,
  // so the Knowledge pane layout reports its controller up here and the shell
  // provides it around toolbar + surface. While a pane-less app (Skills &
  // Tools, registry apps) is active the controller is null → NO_PANES_LAYOUT,
  // which hides the toolbar's pane-toggle buttons.
  const [paneController, setPaneController] = useState<LayoutController | null>(null);

  return (
    <ActiveAppIdContext.Provider value={activeId}>
      <LayoutContext.Provider value={paneController ?? NO_PANES_LAYOUT}>
        <PaneControllerContext.Provider value={setPaneController}>
          {/* Flex-col wrapper so the (conditional) banner strip takes its own
              height and the toolbar + active surface flex into the rest. */}
          <div className="flex flex-col h-full">
            {banners.map((banner) => (
              <Fragment key={banner.id}>{banner.node}</Fragment>
            ))}
            <Toolbar />
            <div className="flex-1 min-h-0">
              {/* Switching routes swaps EVERYTHING below the toolbar: an app
                  surface, a standalone settings page, or a redirect. */}
              <ShellRoutes apps={apps} />
            </div>
          </div>
        </PaneControllerContext.Provider>
      </LayoutContext.Provider>
    </ActiveAppIdContext.Provider>
  );
}

/**
 * The shell-level route table below the persistent toolbar:
 *
 *  - App surfaces at `<path>/*` (a legacy `/` app path maps to `*` for API
 *    stability — apps come before the redirect catch-all, so a match-all app
 *    still wins over it).
 *  - The standalone settings pages — full pages under the toolbar, outside
 *    any app surface (activeAppId is undefined there, so the switcher shows
 *    no checkmark and the pane toggles hide via NO_PANES_LAYOUT). `/connect`
 *    and `/secrets` are OAuth return targets: external redirects land on
 *    these exact URLs, so they must stay routes with these exact paths.
 *  - Redirects: `/` → `/workspace`, and a final catch-all for anything
 *    unknown (including the retired `/library` path).
 *
 * Extracted from AppChrome so the routing behavior is testable without the
 * full provider stack.
 */
export function ShellRoutes({ apps }: { apps: AppDef[] }) {
  return (
    <Routes>
      {apps.map((app) => (
        <Route
          key={app.id}
          path={app.path === '/' ? '*' : `${app.path}/*`}
          element={app.element}
        />
      ))}
      <Route path="/connect" element={<ConnectToolsPage />} />
      <Route path="/secrets" element={<SecretsPage />} />
      <Route path="/account" element={<AccountPage />} />
      <Route path="/external-agent-access" element={<ExternalAgentAccessPage />} />
      <Route path="/roles-and-members" element={<AdminRolesPage />} />
      <Route path="/user-accounts" element={<UserAccountsPage />} />
      <Route path="/tools" element={<ToolsExplorerPage />} />
      {/* `/` consults the onboarding: a brand-new account's FIRST visit lands
          on the welcome page, everyone else (and every later visit) goes to
          Knowledge as always.

          `/auth/*` lands the same way, and that is not decoration. The SSO
          callback scrubs its own URL with a RAW `history.replaceState`
          (`microsoft-oauth.ts`), which BrowserRouter never observes — react
          -router only re-reads location on its own navigations and on
          popstate. So after a Microsoft sign-in the address bar says `/`
          while the router still matches `/auth/microsoft/callback`. Before
          this feature that was invisible, because `/` and `*` both redirected
          to Knowledge; the moment they differ, the first SSO sign-in — the
          exact case onboarding exists for — would fall through the catch-all
          and never be greeted. Routing the callback path here fixes it
          without moving the token-scrub out of the service that owns it.

          The `*` catch-all stays a plain redirect: a mistyped URL is not a
          reason to be onboarded. */}
      <Route path="/" element={<RootLanding />} />
      <Route path="/auth/*" element={<RootLanding />} />
      <Route path="*" element={<Navigate to={KB_ROUTE_PREFIX} replace />} />
    </Routes>
  );
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

/**
 * Provides the change-request creation port. A registry-supplied override
 * (`registry.crCreation`) wins; otherwise the core default opens the direct
 * {@link OpenChangeRequestDialog}. Registries that need runtime state for
 * their override (e.g. the chat dispatch) instead shadow
 * `CrCreationPortContext` from one of their provider wrappers — those render
 * deeper than this host, so the shadow wins for everything under it.
 * Same story for the suggested-prompt seed.
 */
function CrCreationHost({ children }: { children: ReactNode }) {
  const registry = useAppRegistry();
  const [dialogCtx, setDialogCtx] = useState<CrCreationInput | null>(null);

  const port = useMemo<CrCreationPort>(
    () => registry.crCreation ?? { start: (ctx) => setDialogCtx(ctx) },
    [registry],
  );

  const content = (
    <>
      {children}
      {dialogCtx && (
        <OpenChangeRequestDialog
          open
          sourceBranch={dialogCtx.branch}
          initialTargetBranch={dialogCtx.targetBranch}
          onClose={() => setDialogCtx(null)}
        />
      )}
    </>
  );

  return (
    <CrCreationPortContext.Provider value={port}>
      {registry.suggestedPromptSeed ? (
        <SuggestedPromptSeedContext.Provider value={registry.suggestedPromptSeed}>
          {content}
        </SuggestedPromptSeedContext.Provider>
      ) : (
        content
      )}
    </CrCreationPortContext.Provider>
  );
}

/** Auth gate: resolves the session, shows the login screen until the user is in. */
export function AuthGate({ children }: { children: ReactNode }) {
  const auth = useAuthState();

  return (
    <AuthContext.Provider value={auth}>
      {auth.isLoading ? (
        <div className="flex items-center justify-center h-full bg-white text-ink-muted text-sm">
          Loading…
        </div>
      ) : auth.user ? (
        children
      ) : (
        <LoginScreen />
      )}
    </AuthContext.Provider>
  );
}

function AppShell() {
  return (
    <AuthGate>
      <AuthenticatedApp />
    </AuthGate>
  );
}

export function CoreAppShell({ registry }: { registry: AppRegistry }) {
  // Core contributions merge ahead of registry-contributed ones: the review
  // file-viewer panel (core — it renders the pending-changes session served
  // by the core diff backend at /api/workspace/:id/review*) and the core
  // apps (Knowledge + Skills & Tools) that the switcher and AppChrome read.
  const mergedRegistry = useMemo<AppRegistry>(
    () => ({
      ...registry,
      apps: [...CORE_APPS, ...registry.apps],
      fileViewerPanels: [
        { id: 'review', Component: ReviewPanelSurface },
        ...registry.fileViewerPanels.filter((p) => p.id !== 'review'),
      ],
    }),
    [registry],
  );
  // BrowserRouter wraps both auth and authenticated views so the address bar URL
  // (e.g. a pasted /workspace/<branch>/<path> link) survives login —
  // FileRoute picks it up automatically once auth resolves.
  //
  // Registry `topLevelRoutes` (the enterprise /embed* and /onboarding
  // surfaces today) sit OUTSIDE `AppShell` and its auth gate — they own their
  // auth story themselves (see the comments on each route definition). They
  // are matched BEFORE the AppShell catch-all, so a registry can also shadow
  // a shell route (e.g. serve its own /tools) when it needs a different auth
  // wrapper.
  return (
    <AppRegistryContext.Provider value={mergedRegistry}>
      <BrowserRouter>
        {/* Sits above every route (including /embed) — backend downtime during
            a redeploy affects them all equally. */}
        <MaintenanceOverlay />
        <Routes>
          {registry.topLevelRoutes.map((r) => (
            <Route key={r.path} path={r.path} element={r.element} />
          ))}
          <Route path="*" element={<AppShell />} />
        </Routes>
      </BrowserRouter>
    </AppRegistryContext.Provider>
  );
}
