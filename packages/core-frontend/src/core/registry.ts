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
import type { AuthUser, FileTreeEntry } from '@bevel-software/platform-shared';
import type { FileRendererProps } from '../modules/workspace/components/renderers/types';
import type { CommandAction } from '../modules/toolbar/commands/actions';

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
  /** The signed-in person the menu belongs to. */
  user: AuthUser;
}

/**
 * One row of the profile menu. Core rows (External agent access, Secrets,
 * Browse available tools, Account, App roles, User accounts) are built
 * into ProfileMenu and navigate to standalone routed pages; enterprise rows
 * are contributed here. A row opens a dialog (`dialog` — mounted persistently
 * by ProfileMenu, driven by an open flag, so existing dialog components need
 * no changes), runs an action (`onSelect`), or simply declares where it goes
 * (`path`).
 *
 * Skills & Tools is NOT one of these. It is an `AppDef`, reached from the app
 * switcher.
 */
export interface AdminMenuItem {
  id: string;
  label: ReactNode;
  icon?: ReactNode;
  /** 'admin' rows render under the "Admin only" section (admin users only). */
  section?: 'default' | 'admin';
  /** Merge position among core + registered rows of the same section. */
  order?: number;
  /**
   * Where this row goes, DECLARED rather than performed.
   *
   * `onSelect` can navigate too, but only by running code — which makes the
   * destination invisible to anything that is not clicking. The settings nav
   * needs to know a row's URL in order to render it as a link and mark it as
   * current, and a closure cannot be asked. A row with a `path` is therefore
   * the only kind the nav can show; `onSelect`-only rows stay dropdown-only,
   * which is what keeps existing enterprise rows working untouched.
   *
   * Optional, and that is load-bearing: making it required would fail
   * typecheck for every row the enterprise shell already contributes.
   */
  path?: string;
  onSelect?(helpers: AdminMenuItemHelpers): void;
  /**
   * Whether the dropdown offers this row to `user` right now. Asked each time
   * the panel renders, so a row can come and go with state the menu does not
   * own (a preference in storage, say). Absent means always shown.
   */
  isShown?(user: AuthUser): boolean;
  dialog?(props: { open: boolean; onClose(): void }): ReactElement;
}

/**
 * An auxiliary surface mounted inside the FileViewer container (rendered on
 * every FileViewer return path, positioned via its own absolute styling).
 * The enterprise registry contributes the agent-review surface here; the
 * change-request dialog (ChangeRequestDialog) is core and shared by every surface.
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

/**
 * The folder a right-click menu was opened on, as the entry is told about it.
 *
 * Everything here is what the explorer ALREADY knows when it draws the menu;
 * nothing new is asked of the server on an entry's behalf, and nothing here is
 * a gate. `canWrite` and `branchProtected` are for deciding whether to OFFER a
 * verb — the routes an entry's action goes through decide whether to allow it,
 * exactly as they do for "New folder".
 */
export interface FolderMenuContext {
  /** Workspace-relative path of the folder, e.g. `knowledge-base/Data`. */
  path: string;
  /**
   * The branch the explorer's rows came from — the branch the workspace IS,
   * never the one a route may be navigating to. Empty only before the
   * workspace has bootstrapped, which is before there is a row to right-click.
   */
  branch: string;
  /**
   * Whether the viewer may write into this folder — the same answer the
   * explorer's own write hints read, and `false` while it is still unknown.
   */
  canWrite: boolean;
  /** Whether {@link branch} is one of the deployment's protected branches. */
  branchProtected: boolean;
}

/**
 * What a folder menu entry's action may do: the operations Hexis's own entries
 * use, and only those. An entry creates nothing itself — it asks through here,
 * so whatever it creates travels the same routes "New file" and "New folder"
 * travel, and the access rules, the platform-file rules and the
 * protected-branch rules apply to it unchanged.
 *
 * `createFolder` and `createFile` REJECT when the route refuses; an entry that
 * lets the rejection through has its message shown the way a refused "New
 * folder" shows one, so handling it is optional rather than the entry's
 * problem. Paths are workspace-relative, as {@link FolderMenuContext.path} is.
 */
export interface FolderMenuTools {
  createFolder: (path: string) => Promise<void>;
  createFile: (path: string, content?: string) => Promise<void>;
  /** Re-read the file tree, so what was created shows up in it. */
  refreshTree: () => Promise<void>;
  /** Open a path in the surface this tree belongs to. */
  openPath: (path: string) => void;
  /** Show a failure the way the explorer shows its own. */
  showError: (message: string) => void;
}

/**
 * An entry a DEPLOYMENT adds to a folder's right-click menu in the explorer.
 *
 * Core registers none. The explorer and its menus are core's, but a verb like
 * "New ontology" belongs to the distribution that has ontologies, so core
 * offers the place rather than the entry.
 *
 * Registered entries are drawn after core's own, behind a separator, in the
 * order registered — a deployment's verbs read as additions rather than as
 * part of the tree's own vocabulary. With none registered there is no
 * separator and the menu is exactly as it was.
 *
 * `appliesTo` is called every time a folder's menu opens, so keep it cheap and
 * synchronous; one that throws leaves its entry out of that menu and is
 * logged, and the rest of the menu is unaffected.
 */
export interface FolderMenuItemDef {
  /** Stable, and unique among registered entries — it keys the rendered row. */
  id: string;
  label: string;
  icon?: ReactNode;
  /** Whether this entry belongs in THIS folder's menu. */
  appliesTo: (folder: FolderMenuContext) => boolean;
  /** What the entry does. A rejection's message is shown as an error. */
  run: (folder: FolderMenuContext, tools: FolderMenuTools) => void | Promise<void>;
}

/**
 * A way to sign in that the distribution runs for every deployment it hosts,
 * shown in the "Single sign-on" section as a tab of its own, ahead of the
 * form for the deployment's own identity provider.
 *
 * Core's form asks for an issuer, an application and a secret, because a
 * self-hosted deployment has to bring its own. A hosted one does not: the
 * host already runs sign-in with the accounts people have, and what is left
 * for the admin to decide is who may use it. That decision is the
 * distribution's, so is the panel that takes it, and core only gives it a
 * place.
 *
 * The section opens on this tab unless the deployment has its own provider
 * configured, in which case it opens on that one: the tab shown is the way
 * of signing in that is in effect.
 *
 * THE PANEL SITS INSIDE THE SETTINGS FORM. It must not render a `<form>` of
 * its own, its buttons must be `type="button"`, and it saves through its
 * own requests: "Save and continue" saves core's settings and nothing of
 * the panel's.
 */
export interface SignInOptionDef {
  /** The tab's name, e.g. "Google and Microsoft". */
  label: string;
  /** The name of the tab holding core's own form. Default "Your own provider". */
  ownProviderLabel?: string;
  Panel: ComponentType<SignInOptionPanelProps>;
}

export interface SignInOptionPanelProps {
  /** Where the form stands: the first-run gate or the Deployment page. */
  variant: 'setup' | 'settings';
  /** Whether the deployment has an identity provider of its own configured. */
  ownProviderConfigured: boolean;
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

/** Props for the overlay-provided panel on the Groups settings page. */
export interface GroupsDirectoryPanelProps {
  /** The active group source, as the roster reports it. */
  mode: 'manual' | 'idp';
  /** Re-fetch the roster — call after any action that may flip the mode. */
  onDirectoryChanged: () => void;
  /**
   * Report whether a directory connection EXISTS — which the roster alone
   * cannot see: between connecting and the first provisioning push the mode
   * still reads 'manual' (the synced file hasn't landed), yet the IdP already
   * owns groups and manual edits would go dormant on the first push. The page
   * suppresses manual CRUD while this is true.
   */
  onConnectedChange: (connected: boolean) => void;
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
   * auto-update, admin, event bus) but OUTSIDE the layout, so they
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
   * Extra entries in a FOLDER's right-click menu in the explorer, drawn after
   * core's own behind a separator (see {@link FolderMenuItemDef}).
   */
  folderMenuItems: FolderMenuItemDef[];
  /**
   * The Groups settings page's directory-connection panel. Core's Groups
   * page manages MANUAL groups and renders the IdP-synced roster read-only;
   * HOW a deployment connects an identity provider (e.g. SCIM provisioning)
   * is an enterprise concern, so the page reserves this slot for an overlay
   * panel. Rendered below the groups list in both modes; absent means the
   * page simply never mentions a directory connection.
   */
  groupsDirectoryPanel?: ComponentType<GroupsDirectoryPanelProps>;
  /**
   * A panel at the foot of the Deployment page, below the settings form.
   * Core's page holds what every deployment has — the repository, the branch
   * model, sign-in. What a deployment IS beyond that belongs to the
   * distribution that runs it: a hosted workspace has a plan and can be
   * deleted by its admin, a self-hosted one is deleted by whoever owns the
   * server, and core knows neither. The page reserves this slot for it.
   *
   * Rendered for admins only, like the page itself, and independently of the
   * settings load: a panel that offers a way out of the deployment must not
   * disappear because the settings could not be read. Rendered inside a
   * boundary, so the independence holds both ways: a panel that throws loses
   * its own place on the page, never the settings form above it. Absent means
   * the page ends with its form, as it always has.
   */
  deploymentPanel?: ComponentType;
  /**
   * A way to sign in that the DISTRIBUTION runs, offered beside the
   * deployment's own identity provider. See {@link SignInOptionDef}.
   */
  signInOption?: SignInOptionDef;
  /**
   * What the first-run storage screen calls the repository the deployment
   * keeps for itself: the card a new admin is steered towards.
   *
   * WHO keeps it is a property of the distribution, not of the screen. On a
   * core deployment it is this server ("This server keeps it"); a hosted
   * distribution keeps it on the admin's behalf and says so by name. Absent
   * means core's words.
   *
   * The description travels WITH the title for the same reason the
   * `welcomeExit` label travels with its path: a caller renaming the keeper
   * without the sentence under it is how the card would come to contradict
   * itself.
   */
  managedStorage?: { title: string; description: string };
  /**
   * How many unread items the gear menu's badge should show, if anything is
   * counting. CORE COUNTS NOTHING: the feedback inbox behind that badge is an
   * enterprise module, and core polled its endpoint every thirty seconds
   * regardless — a guaranteed 404 on every core deployment, forever, filling
   * the console of the one screen an operator looks at when something is
   * wrong. Absent means no badge and, more to the point, no request.
   */
  adminUnreadCount?: (since: string | null) => Promise<number>;
  /**
   * Static override of the change-request port. Overrides that need runtime
   * state (e.g. the chat dispatch) should instead shadow
   * {@link CrCreationPortContext} from one of the `providers` wrappers.
   */
  crCreation?: CrCreationPort;
  /**
   * Static override of the suggested-prompt seeding callback (see
   * {@link SuggestedPromptSeedContext} for the runtime-state variant, and for
   * why nothing in core consumes either any more — the Knowledge viewer's
   * empty state offers real pages now, not prompts). Still public API: a
   * registry-provided chat surface may hold it and seed from its own
   * affordances.
   */
  suggestedPromptSeed?: (prompt: string) => void;
  /**
   * Where the welcome page's exits go, and what the secondary one is called.
   *
   * The welcome page ends by sending a new person somewhere they can start,
   * and WHERE that is, is a property of the product rather than of the page.
   * Core sends them to their own skills shelf, because on a core deployment
   * that is the product and a fresh knowledge base is empty. A distribution
   * whose centre of gravity is the knowledge graph wants the opposite, and
   * would otherwise greet every new user and then leave them in a surface
   * they did not come for.
   *
   * Both exits use the value, so they cannot drift apart. A pending deep link
   * still outranks it — someone who followed a link is owed that link, and
   * onboarding must never eat an intention.
   *
   * The label travels WITH the path deliberately: "Go to your skills →"
   * pointing at a knowledge base is a lie, and a caller changing one without
   * the other is the likeliest way to produce it.
   */
  welcomeExit?: { path: string; label: string };
  /**
   * A panel inside the invite dialog, between the role choice and the footer.
   *
   * Core invites by creating accounts and knows nothing about what a place in
   * the deployment costs. A hosted deployment does: it renders its seat meter
   * here (how many of the plan's seats these invites would fill — `inviting`
   * is the number of valid addresses entered so far), and its "anyone at
   * your domain can join" switch. Rendered inside a boundary, so a panel that
   * throws costs its own place, never the invite form. Absent means core
   * renders nothing there.
   */
  inviteExtras?: ComponentType<{ inviting: number }>;
  /**
   * Commands a distribution adds to the toolbar's command menu (Ctrl/⌘K),
   * listed after core's own.
   *
   * Core's commands are the verbs every deployment has — New page, Invite
   * people, the apps, the settings pages. A verb like "New ontology" belongs
   * to the distribution that has ontologies, so core offers the place rather
   * than the command, as it does for folder-menu entries. Each one is plain
   * data plus `visible` and `run`, both handed the menu's context (router,
   * admin verdict, page on screen) — see `CommandAction`. An id core already
   * uses is dropped; a `visible` that throws costs only its own row. Absent
   * means the menu offers core's commands and no others.
   */
  commandActions?: CommandAction[];
  /**
   * Where a renderer that draws the knowledge graph (a dashboard's HTML)
   * gets the graph from, on each surface it can be mounted on: the app,
   * where the reader's session reads it, and the embed, where only the
   * embed token does. Core has no graph; a distribution that has one
   * registers both, and its renderer asks the surface
   * (`RendererSurface.loadKbGraph`) rather than any address, so the same
   * renderer draws inside a chat or an issue panel as it draws in the app.
   */
  kbGraphSource?: KbGraphSource;
}

/** See {@link AppRegistry.kbGraphSource}. What the graph is, is the distribution's; core carries it as is. */
export interface KbGraphSource {
  /** The graph as the signed-in reader may see it, for `workspaceId`. */
  inApp(workspaceId: string): Promise<unknown>;
  /** The graph as the embed token's viewer may see it. */
  inEmbed(token: string): Promise<unknown>;
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
  folderMenuItems: [],
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

/**
 * Lets a surface rendered under ONE app's URL prefix claim ANOTHER app as
 * active. The path-prefix rule in {@link activeAppId} answers for every
 * ordinary location, but a canonical URL can put one app's surface under
 * another's prefix — library item pages live at `/workspace/...` file URLs
 * (see `WorkspaceItemGate`) — and the toolbar should highlight the app whose
 * surface is actually on screen. Call with an app id while such a surface is
 * mounted and with `null` on unmount; the shell holds the claim above the
 * toolbar. No-op default so surfaces render unchanged outside the shell.
 */
export const AppClaimContext = createContext<(id: string | null) => void>(() => {});

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
 * Seeds the chat composer with a suggested prompt. Null → no chat surface is
 * registered.
 *
 * NO CORE CONSUMER. It used to be the Knowledge viewer's empty state, which
 * offered three canned questions for an assistant — on a deployment with no
 * chat surface they never rendered, and on one with a chat surface they sent a
 * reader looking at an empty page to go and ask something instead of opening
 * one of the pages the file tree was already showing them. That empty state
 * offers real documents now. The port stays because it is public API a
 * registry may hold, and a chat surface that provides it is free to seed from
 * its own affordances.
 */
export const SuggestedPromptSeedContext = createContext<
  ((prompt: string) => void) | null
>(null);

export function useSuggestedPromptSeed(): ((prompt: string) => void) | null {
  return useContext(SuggestedPromptSeedContext);
}
