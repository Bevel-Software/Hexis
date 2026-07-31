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
 * One row of the toolbar gear menu. Core rows (Secrets, External agent
 * access, Browse available tools, Roles & Members) are built into AdminMenu;
 * enterprise rows are contributed here. A row either opens a dialog
 * (`dialog` — mounted persistently by AdminMenu, driven by an open flag, so
 * existing dialog components need no changes) or runs an action (`onSelect`).
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

export interface AppRegistry {
  /** Routes mounted OUTSIDE the app shell (own auth handling, no workspace chrome). */
  topLevelRoutes: RouteDef[];
  /** Extra routes inside the viewer pane's `<Routes>` (e.g. OAuth landings). */
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
};

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
