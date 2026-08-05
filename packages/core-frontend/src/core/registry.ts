/**
 * The app registry: the contract between the core shell (`CoreAppShell`) and
 * optional (enterprise) modules. The core owns workspace, git, pr, access,
 * auth, workflow/SSE, layout, secrets-vault, tools, toolbar and the admin
 * roles page; everything else (chat, connectors, routines, watchlist, voice,
 * embed, review, onboarding, admin LLM/feedback pages) is contributed through
 * an `AppRegistry` instance passed to `<CoreAppShell registry={...} />`.
 *
 * Follows the same registration pattern as the file-renderer registry in
 * `modules/workspace/components/renderers/index.ts`: a plain data structure
 * the shell iterates over, no runtime plugin machinery.
 */
import {
  createContext,
  useContext,
  type ComponentType,
  type ReactElement,
  type ReactNode,
} from 'react';
import type { FileTreeEntry } from '@bevel-software/platform-shared';
import type { FileRendererProps } from '../modules/workspace/components/renderers/types';

/** A route contributed to one of the shell's `<Routes>` blocks. */
export interface RouteDef {
  path: string;
  element: ReactElement;
}

/**
 * One pane of the main (three-pane today) layout. The core registers
 * `explorer` and `viewer`; the enterprise registry contributes `chat`.
 * The layout's panel ids (and therefore the persisted layout shape) are
 * derived from the registered pane list.
 *
 * ⚠️ The pane list must be static for the lifetime of the shell — panes are
 * not designed to be added/removed at runtime.
 */
export interface PaneDef {
  id: string;
  node: ReactNode;
  /** Merge position among all registered panes (ascending). */
  order?: number;
  /** e.g. '17%' — omitted panes share the remaining space. */
  defaultSize?: string;
  minSize?: string;
  maxSize?: string;
  /** Collapsible panes get collapse tracking + a toolbar toggle. */
  collapsible?: boolean;
  /**
   * Render this pane as the app's nav spine (`SidebarFrame`) instead of as a
   * panel in the resizable group. At most one pane per app should set it.
   *
   * A sidebar is not a pane that happens to be on the left: its width is a
   * shared, persisted preference that survives switching to an app with no
   * panes at all (Skills & Tools has no pane group and the same sidebar), so
   * it cannot live in a per-app panel layout. `defaultSize`/`minSize`/
   * `maxSize` are ignored for it — the frame owns the range.
   */
  sidebar?: boolean;
}

/** A banner strip rendered above the main layout (order ascending). */
export interface BannerDef {
  id: string;
  node: ReactNode;
  order?: number;
}

export interface AdminMenuItemHelpers {
  /** Close the gear menu and return focus to the trigger. */
  closeMenu(): void;
  /** react-router navigation. */
  navigate(to: string): void;
}

/**
 * One row of the toolbar gear menu. Core rows (Skills & Tools, External
 * agent access, Secrets, Browse available tools, Roles & Members) are built
 * into AdminMenu and navigate to standalone routed pages; enterprise rows
 * are contributed here. A row either opens a dialog (`dialog` — mounted
 * persistently by AdminMenu, driven by an open flag, so existing dialog
 * components need no changes) or runs an action (`onSelect`, e.g. a
 * navigation).
 */
export interface AdminMenuItem {
  id: string;
  label: ReactNode;
  icon?: ReactNode;
  /** 'admin' rows render under the "Admin only" section (admin users only). */
  section?: 'default' | 'admin';
  /** Merge position among core + registered rows of the same section. */
  order?: number;
  onSelect?(helpers: AdminMenuItemHelpers): void;
  dialog?(props: { open: boolean; onClose(): void }): ReactElement;
}

/**
 * An auxiliary surface mounted inside the FileViewer container (rendered on
 * every FileViewer return path, positioned via its own absolute styling).
 * The enterprise registry contributes the agent-review surface here; the
 * change-request viewer (PrViewer) is core and stays hard-mounted.
 */
export interface FileViewerPanelDef {
  id: string;
  Component: ComponentType;
}

/**
 * A file renderer OVERRIDE consulted by the FileViewer before the built-in
 * extension map (`modules/workspace/components/renderers`). The enterprise
 * registry replaces the plain `.html` renderer with one that inlines its
 * vendored d3/mermaid libraries and the KB graph client.
 */
export interface FileRendererDef {
  /** Lowercase extensions including the dot, e.g. `['.html', '.htm']`. */
  extensions: string[];
  Component: ComponentType<FileRendererProps>;
}

/**
 * A row appended to the file explorer's "Pinned" section (after the pinned
 * folders). The component receives the explorer's merged file tree (null
 * while loading) and renders its own row — plus any overlay that row opens.
 * The enterprise knowledge system contributes its "Graph view" entry here.
 */
export interface ExplorerItemDef {
  id: string;
  Component: ComponentType<{ tree: FileTreeEntry | null }>;
}

/** Context passed when the user asks to open a change request from a draft. */
export interface CrCreationInput {
  workspaceId: string | null;
  /** Source branch (the user's current shared draft). */
  branch: string;
  /** Target branch, when the caller already picked one. */
  targetBranch?: string;
  /** True when this creation is part of a conflict-recovery flow. */
  conflict?: boolean;
}

/** Context for "my draft is behind / a pull failed" recovery. */
export interface PullIssueInput {
  workspaceId: string | null;
  branch: string;
  /** 'behind' = updates waiting; 'pull-failed' = a direct pull was refused. */
  kind: 'behind' | 'pull-failed';
  /** Plain-language classification of the failure (never raw git output). */
  reason?: string;
}

/** Context for conflicts while applying/refreshing an existing change request. */
export interface CrConflictInput {
  kind: 'apply' | 'refresh';
  changeRequestNumber: number;
  base: string;
  conflictedPaths: string[];
}

/**
 * The change-request port. Core git/pr components call this instead of
 * seeding chat prompts directly, which keeps the chat module out of core.
 *
 *  - Default (no override registered): `start` opens the core
 *    `OpenChangeRequestDialog`, which posts straight to
 *    `POST /api/workflow/change-requests`. The optional recovery methods are
 *    absent, so their affordances hide / fall back to inline errors.
 *  - Enterprise: a provider shadows {@link CrCreationPortContext} with an
 *    implementation that seeds the chat composer (agent-driven flow) —
 *    today's behavior, unchanged.
 */
export interface CrCreationPort {
  start(ctx: CrCreationInput): void;
  /** Absent → the "Ask assistant" affordance hides. */
  resolvePullIssue?(ctx: PullIssueInput): void;
  /** Absent → apply/refresh conflicts surface as inline errors. */
  resolveCrConflicts?(ctx: CrConflictInput): void;
}

/**
 * An entry in the app switcher behind the toolbar brand (top-left). Each app
 * is a top-level SURFACE: switching apps swaps everything below the (always
 * mounted) toolbar for the app's `element`. Core ships "Knowledge" (the pane
 * workspace) and "Skills & Tools"; the enterprise registry appends its own.
 */
export interface AppDef {
  id: string;
  label: string;
  /** Route the switcher navigates to. Also drives the active highlight and
   * the surface's route (`<path>/*`): the app whose path is the longest
   * prefix of the current location is active. Core ships Knowledge at
   * '/workspace' and Skills & Tools at '/skills-and-tools'; on locations no
   * app claims (the standalone settings pages) no app is active. A '/' path
   * is still honored as a match-everything fallback for API stability, but
   * no core app uses it anymore. */
  path: string;
  /** The full-height surface rendered below the toolbar while active. */
  element: ReactElement;
  /** One-line subtitle under the label in the switcher list. */
  description?: string;
  /** Sort order in the list (core: Knowledge 10, Skills & Tools 20). */
  order?: number;
}

/**
 * Pick the active app for a location: the app whose `path` is the longest
 * prefix of the pathname, or undefined when no app claims it (the standalone
 * settings pages — no switcher checkmark, no pane toggles). A '/' app path
 * matches everything and only wins when no more specific path does; core no
 * longer registers one (Knowledge lives at '/workspace'), but the fallback
 * semantics are kept for registries that do.
 */
export function activeAppId(apps: AppDef[], pathname: string): string | undefined {
  let best: AppDef | undefined;
  for (const app of apps) {
    const matches =
      app.path === '/'
        ? true
        : pathname === app.path || pathname.startsWith(`${app.path}/`);
    if (matches && (!best || app.path.length > best.path.length)) best = app;
  }
  return best?.id;
}

/**
 * A toolbar contribution rendered in the left cluster next to the app
 * switcher (and on the compact second row on narrow screens). The node runs
 * under the shell's providers, so it can read {@link useActiveAppId} and
 * render only for specific apps — that is how the enterprise scopes its
 * branch switcher to the Knowledge app.
 */
export interface ToolbarItemDef {
  id: string;
  node: ReactNode;
  order?: number;
}

export interface AppRegistry {
  /** Apps appended to the toolbar's app switcher (see {@link AppDef}). */
  apps: AppDef[];
  /** Toolbar left-cluster contributions (see {@link ToolbarItemDef}). */
  toolbarItems: ToolbarItemDef[];
  /** Routes mounted OUTSIDE the app shell (own auth handling, no workspace chrome). */
  topLevelRoutes: RouteDef[];
  /**
   * Extra routes inside the viewer pane's `<Routes>`. The viewer pane is
   * nested under the Knowledge surface's `/workspace/*` route, so these
   * paths are RELATIVE to `/workspace` (a route registered as 'connectors'
   * renders at `/workspace/connectors`). Surfaces that need a top-level URL
   * of their own belong in `topLevelRoutes` instead.
   */
  viewerRoutes: RouteDef[];
  /**
   * Ordered wrappers applied INSIDE the core providers (workspace, git,
   * auto-update, pr-viewer, admin, event bus) but OUTSIDE the layout, so they
   * can read core state and every pane sees them. `providers[0]` is outermost.
   */
  providers: Array<(children: ReactNode) => ReactElement>;
  /** Panes merged with the core explorer/viewer panes (see {@link PaneDef}). */
  panes: PaneDef[];
  /** Banners merged with the core banner strip above the layout. */
  banners: BannerDef[];
  /** Gear-menu rows merged with the core rows (see {@link AdminMenuItem}). */
  adminMenuItems: AdminMenuItem[];
  /** Auxiliary FileViewer surfaces (see {@link FileViewerPanelDef}). */
  fileViewerPanels: FileViewerPanelDef[];
  /** File-renderer overrides by extension (see {@link FileRendererDef}). */
  renderers: FileRendererDef[];
  /** Extra rows in the explorer's Pinned section (see {@link ExplorerItemDef}). */
  explorerItems: ExplorerItemDef[];
  /**
   * Static override of the change-request port. Overrides that need runtime
   * state (e.g. the chat dispatch) should instead shadow
   * {@link CrCreationPortContext} from one of the `providers` wrappers.
   */
  crCreation?: CrCreationPort;
  /**
   * Static override of the suggested-prompt seeding callback (see
   * {@link SuggestedPromptSeedContext} for the runtime-state variant). When
   * neither is provided the FileViewer hides its suggested-prompt buttons.
   */
  suggestedPromptSeed?: (prompt: string) => void;
}

export const EMPTY_REGISTRY: AppRegistry = {
  topLevelRoutes: [],
  viewerRoutes: [],
  providers: [],
  panes: [],
  banners: [],
  adminMenuItems: [],
  fileViewerPanels: [],
  renderers: [],
  explorerItems: [],
  apps: [],
  toolbarItems: [],
};

/**
 * The active app's id (see {@link activeAppId}), provided by the shell above
 * the toolbar and every app surface. `undefined` outside the shell (tests,
 * standalone renders) — treat that as "no app context".
 */
export const ActiveAppIdContext = createContext<string | undefined>(undefined);

export function useActiveAppId(): string | undefined {
  return useContext(ActiveAppIdContext);
}

/** Convenience builder: fill in the empty defaults for unspecified fields. */
export function makeRegistry(partial: Partial<AppRegistry>): AppRegistry {
  return { ...EMPTY_REGISTRY, ...partial };
}

/**
 * The registry itself, readable anywhere under `CoreAppShell`. Defaults to
 * the empty registry so components (AdminMenu, FileViewer, layout) degrade to
 * core-only behavior when rendered standalone (tests, storybooks).
 */
export const AppRegistryContext = createContext<AppRegistry>(EMPTY_REGISTRY);

export function useAppRegistry(): AppRegistry {
  return useContext(AppRegistryContext);
}

/**
 * The change-request port (see {@link CrCreationPort}). The core shell always
 * provides a default (the direct-creation dialog); enterprise wrappers may
 * shadow it. Null only when rendered outside the shell entirely.
 */
export const CrCreationPortContext = createContext<CrCreationPort | null>(null);

export function useCrCreationPort(): CrCreationPort | null {
  return useContext(CrCreationPortContext);
}

/**
 * Seeds the chat composer with a suggested prompt (FileViewer empty state).
 * Null → no chat surface registered → the suggested-prompt UI hides.
 */
export const SuggestedPromptSeedContext = createContext<
  ((prompt: string) => void) | null
>(null);

export function useSuggestedPromptSeed(): ((prompt: string) => void) | null {
  return useContext(SuggestedPromptSeedContext);
}
