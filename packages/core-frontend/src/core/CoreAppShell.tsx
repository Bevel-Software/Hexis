import { useEffect, useMemo, useState, Fragment, type ReactNode } from 'react';
import { BrowserRouter, Routes, Route, useNavigate } from 'react-router-dom';
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
import { FileRoute } from '../modules/workspace/components/FileRoute';
import { KB_ROUTE_PREFIX } from '../modules/workspace/routing/kb-routes';
import { AppLayout } from '../modules/layout/components/AppLayout';
import { MaintenanceOverlay } from '../modules/layout/components/MaintenanceOverlay';
import { AdminProvider } from '../modules/admin/state/admin.context';
import { RolesCorruptedBanner } from '../modules/admin/components/RolesCorruptedBanner';
import { ReviewProvider } from '../modules/review/state/ReviewProvider';
import { ReviewPanelSurface } from '../modules/review/components/ReviewPanelSurface';
import { ConnectToolsPage } from '../modules/secrets-vault/components/ConnectToolsPage';
import { SecretsVaultPage } from '../modules/secrets-vault/components/SecretsVaultPage';
import { LibraryPage } from '../modules/library/components/LibraryPage';
import { OpenChangeRequestDialog } from '../modules/pr/components/OpenChangeRequestDialog';
import {
  AppRegistryContext,
  CrCreationPortContext,
  SuggestedPromptSeedContext,
  useAppRegistry,
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
// hard-coded three-pane layout exactly.
const CORE_PANES: PaneDef[] = [
  {
    id: 'explorer',
    order: 10,
    node: <FileExplorer />,
    defaultSize: '17%',
    minSize: '10%',
    maxSize: '35%',
    collapsible: true,
  },
  { id: 'viewer', order: 20, node: <ViewerRoutes />, minSize: '30%' },
];

function AppChrome() {
  const registry = useAppRegistry();
  const banners = useMemo(
    () =>
      [...CORE_BANNERS, ...registry.banners].sort(
        (a, b) => (a.order ?? 100) - (b.order ?? 100),
      ),
    [registry],
  );
  const panes = useMemo(
    () =>
      [...CORE_PANES, ...registry.panes].sort(
        (a, b) => (a.order ?? 100) - (b.order ?? 100),
      ),
    [registry],
  );

  return (
    /* Flex-col wrapper so the (conditional) corrupted banner
       takes its own height and the h-full layout flexes into
       the rest. When the banner is null this is a no-op pass
       through — AppLayout still fills the viewport. */
    <div className="flex flex-col h-screen">
      {banners.map((banner) => (
        <Fragment key={banner.id}>{banner.node}</Fragment>
      ))}
      <div className="flex-1 min-h-0">
        <AppLayout header={<Toolbar />} panes={panes} />
      </div>
    </div>
  );
}

/** The viewer pane: registry routes first, then the core routes. */
function ViewerRoutes() {
  const registry = useAppRegistry();
  return (
    <Routes>
      {registry.viewerRoutes.map((r) => (
        <Route key={r.path} path={r.path} element={r.element} />
      ))}
      {/* OAuth landing pages — external redirects
          arrive here, so these stay routes (not
          only gear-menu dialogs): /connect is both the
          external-agent authorization step and the
          tool sign-in return page; /secrets is where
          the standalone-secret OAuth callback returns
          (#authorized/#error), opening the Secrets
          dialog like the registered /connectors route
          does for Connectors. */}
      <Route path="/connect" element={<ConnectToolsPage />} />
      <Route path="/secrets" element={<SecretsRoute />} />
      {/* The Library — core skills/integrations/loadout view (gear-menu row
          "Library" navigates here). */}
      <Route path="/library" element={<LibraryPage />} />
      <Route path={`${KB_ROUTE_PREFIX}/:branch/*`} element={<FileRoute />} />
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
        <div className="flex items-center justify-center h-full bg-white text-slate-600 text-sm">
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

/**
 * Landing for the standalone-secret OAuth return (`/secrets#authorized=…`).
 * Same pattern as the enterprise ConnectorsRoute: the Secrets panel is a
 * gear-menu dialog, but the backend callback redirects the browser here, so
 * this route opens that dialog (which reads the hash); closing it returns to
 * the workspace.
 */
function SecretsRoute() {
  const navigate = useNavigate();
  return <SecretsVaultPage open onClose={() => navigate('/', { replace: true })} />;
}

function AppShell() {
  return (
    <AuthGate>
      <AuthenticatedApp />
    </AuthGate>
  );
}

export function CoreAppShell({ registry }: { registry: AppRegistry }) {
  // Core file-viewer panels merge ahead of registry-contributed ones. The
  // agent-review surface is core: it renders the pending-changes session
  // served by the core diff backend (/api/workspace/:id/review*).
  const mergedRegistry = useMemo<AppRegistry>(
    () => ({
      ...registry,
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
  // Registry `topLevelRoutes` (the enterprise /embed*, /tools and /onboarding
  // surfaces today) sit OUTSIDE `AppShell` and its auth gate — they own their
  // auth story themselves (see the comments on each route definition).
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
