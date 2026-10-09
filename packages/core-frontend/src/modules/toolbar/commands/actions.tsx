import type { ReactNode } from 'react';
import type { AuthUser } from '@bevel-software/platform-shared';
import { ArrowRight, FilePlus, Pencil, Plug, Settings, UserPlus } from 'lucide-react';
import type { AdminMenuItem, AppDef } from '../../../core/registry';
import type { MenuSections } from '../../settings/settings-nav-items';
import type { InviteDialogController } from '../../onboarding/state/invite-dialog.context';
import { WELCOME_PATH } from '../../onboarding/paths';

/**
 * The commands the toolbar's menu can run, beside the pages and items it
 * finds: "Create new page", "Invite people", "Settings: Secrets".
 *
 * A command is DATA plus two functions of a {@link CommandContext}, never a
 * hook or a component of its own: whether it is offered right now
 * (`visible`), and what it does (`run`). Everything a command needs from the
 * app — the router, the admin verdict, the page on screen, the invite dialog —
 * arrives in that one context, built once by `useCommandActions`. That keeps
 * this list pure and testable, and it is what lets a distribution contribute
 * commands (`AppRegistry.commandActions`) without reaching into core's hooks.
 */

/** What a command can see and use when it is offered and when it runs. */
export interface CommandContext {
  /** react-router navigation. */
  navigate(to: string): void;
  /** The signed-in person, or null signed out. */
  user: AuthUser | null;
  isAdmin: boolean;
  /** The app on screen (see `useActiveAppId`); undefined on a settings page. */
  activeAppId: string | undefined;
  /** The workspace path of the file open in the viewer, or null. */
  openFilePath: string | null;
  /**
   * The page on screen an Edit click would open for editing right now, or
   * null — already editing, not writable, locked, nothing open (see
   * `workspace/state/editable-page`).
   */
  editablePage: string | null;
  /** Open a known workspace path; `edit` opens it in the editor (see `useFileNav`). */
  openWorkspacePath(path: string, options?: { edit?: boolean; replace?: boolean }): void;
  /** THE invite dialog, or null where none is mounted. */
  invite: InviteDialogController | null;
  /**
   * Create an untitled page in the Knowledge folder and open it for editing
   * (`useCreatePage`); null until the workspace knows where that folder is.
   * Rejects with a message ready to show.
   */
  createPage: (() => Promise<string>) | null;
  /** The connect-your-agent onboarding is still open for this person. */
  onboardingPending: boolean;
}

/** One letter, with or without Shift (see {@link CommandAction.shortcut}). */
export interface CommandShortcut {
  /** The letter, `a` to `z`; matched without regard to case. */
  key: string;
  /** Held: ⇧K. Not held: K on its own. */
  shift?: boolean;
}

export interface CommandAction {
  /** Stable and unique among all commands — it keys the row and the suggestions. */
  id: string;
  /** What the row says, and the first thing a query is matched against. */
  label: string;
  /** Other words someone might type for it; matched like the label, never shown. */
  keywords?: string[];
  /** Faint text after the label, naming where the command belongs (a distribution's area, say). */
  group?: string;
  /**
   * The key that runs it outside the menu: one letter, `a` to `z`, with or
   * without Shift — `{ key: 'c' }`, or `{ key: 'k', shift: true }` for ⇧K.
   * Shown on the row as its hint AND bound by `useCommandShortcuts`, under
   * the same guards as core's, so a hint is never a key that does nothing.
   * Core's are filled in from {@link COMMAND_SHORTCUTS}. A registry
   * command's shortcut is dropped at merge time, hint and all, and said so in
   * the console, when its key is not one letter or is already bound: give it
   * another.
   */
  shortcut?: CommandShortcut;
  /** The row's icon; a generic arrow when absent. */
  icon?: ReactNode;
  /** Whether to offer it now. Called on every render of the menu, so keep it cheap. */
  visible(ctx: CommandContext): boolean;
  /**
   * Do it. The menu has already closed. A rejection's message is shown — the
   * menu opens again to say it — so a command need not report its own failure.
   */
  run(ctx: CommandContext): void | Promise<void>;
}

const ICON_SIZE = 15;

const NEW_PAGE: CommandAction = {
  id: 'new-page',
  label: 'Create new page',
  keywords: ['new page', 'create page', 'add page', 'write', 'document', 'note', 'untitled'],
  icon: <FilePlus size={ICON_SIZE} />,
  visible: (ctx) => ctx.createPage !== null,
  run: async (ctx) => {
    await ctx.createPage?.();
  },
};

/**
 * The page on screen, into the editor — through the same request the
 * just-created page uses, so the lock and the fresh read are not skipped.
 * `replace`: it is the page already showing, and a second history entry for
 * it would make Back look broken.
 */
const EDIT_PAGE: CommandAction = {
  id: 'edit-page',
  label: 'Edit this page',
  keywords: ['edit', 'write', 'change', 'modify'],
  icon: <Pencil size={ICON_SIZE} />,
  visible: (ctx) => ctx.editablePage !== null && ctx.editablePage === ctx.openFilePath,
  run: (ctx) => {
    if (ctx.editablePage) ctx.openWorkspacePath(ctx.editablePage, { edit: true, replace: true });
  },
};

/** Admins only, like the toolbar's Invite button: creating accounts is an admin act. */
const INVITE: CommandAction = {
  id: 'invite',
  label: 'Invite people',
  keywords: ['team', 'teammates', 'members', 'users', 'add people', 'accounts'],
  icon: <UserPlus size={ICON_SIZE} />,
  visible: (ctx) => ctx.isAdmin && ctx.invite !== null,
  run: (ctx) => ctx.invite?.open(),
};

/** Everyone's: the welcome page is how a person connects their own agent, onboarding concluded or not. */
const CONNECT_AGENT: CommandAction = {
  id: 'connect-agent',
  label: 'Connect your agent',
  keywords: ['claude', 'chatgpt', 'cursor', 'mcp', 'set up', 'setup', 'welcome', 'connector'],
  icon: <Plug size={ICON_SIZE} />,
  visible: () => true,
  run: (ctx) => ctx.navigate(WELCOME_PATH),
};

/** The id of the "Go to" command for an app — what suggestions and shortcuts refer to it by. */
export function goToAppActionId(appId: string): string {
  return `go-to:${appId}`;
}

/**
 * The shortcuts, keyed by the command they run: `C` for Create new page, ⇧I
 * for Invite people, ⇧K for Knowledge and ⇧S for Skills & Tools — the two
 * apps of the top bar's toggle. No other command has one. ONE table, read
 * both by `useCommandShortcuts` (which binds the keys) and by the list below
 * (which shows them as hints), so a row never advertises a key that does
 * nothing.
 */
export const COMMAND_SHORTCUTS: Readonly<Record<string, CommandShortcut>> = {
  'new-page': { key: 'c' },
  invite: { key: 'i', shift: true },
  [goToAppActionId('knowledge')]: { key: 'k', shift: true },
  [goToAppActionId('skills-tools')]: { key: 's', shift: true },
};

/** A core command with its hint from {@link COMMAND_SHORTCUTS}, if it has one. */
function withShortcutHint(action: CommandAction): CommandAction {
  const shortcut = COMMAND_SHORTCUTS[action.id];
  return shortcut ? { ...action, shortcut } : action;
}

/**
 * One "Go to …" per app in the switcher, in the switcher's order. Offered
 * even for the app on screen: from deep inside it, going to its start is
 * still somewhere.
 */
function appActions(apps: readonly AppDef[]): CommandAction[] {
  return [...apps]
    .sort((a, b) => (a.order ?? 100) - (b.order ?? 100))
    .map((app) => ({
      id: goToAppActionId(app.id),
      label: `Go to ${app.label}`,
      keywords: [app.label, 'switch app', 'open app'],
      icon: <ArrowRight size={ICON_SIZE} />,
      visible: () => true,
      run: (ctx) => ctx.navigate(app.path),
    }));
}

/**
 * A command per row the profile menu shows, from the same merged list it
 * reads (`useMenuSections`) — the admin section for admins only, as there.
 *
 * Two kinds of row are left out. A `dialog` row's dialog is mounted by the
 * profile menu, driven by the menu's own open flags, so nothing outside it
 * can open one. And a row whose label is not plain text cannot be typed for.
 */
function settingsActions(settings: MenuSections): CommandAction[] {
  const toAction = (item: AdminMenuItem, adminOnly: boolean): CommandAction | null => {
    if (item.dialog || typeof item.label !== 'string') return null;
    if (!item.path && !item.onSelect) return null;
    const label = item.label;
    return {
      id: `settings:${item.id}`,
      label: `Settings: ${label}`,
      keywords: [label, 'preferences'],
      icon: <Settings size={ICON_SIZE} />,
      // The profile menu's gates: a person to show it to, admin rows for
      // admins, and the row's own `isShown` for this person right now.
      visible: (ctx) =>
        ctx.user !== null && (!adminOnly || ctx.isAdmin) && (item.isShown?.(ctx.user) ?? true),
      run: (ctx) => {
        if (!ctx.user) return;
        // The profile menu's precedence, minus the dialog: code first, then
        // the declared destination.
        if (item.onSelect) item.onSelect({ closeMenu: () => {}, navigate: ctx.navigate, user: ctx.user });
        else if (item.path) ctx.navigate(item.path);
      },
    };
  };
  return [
    ...settings.defaultItems.map((item) => toAction(item, false)),
    ...settings.adminItems.map((item) => toAction(item, true)),
  ].filter((a): a is CommandAction => a !== null);
}

/**
 * Every command core offers, before visibility: the page verbs, the people
 * verbs, the apps, then the settings. The order is the tie-breaker when two
 * commands match a query equally well.
 */
export function coreCommandActions({
  apps,
  settings,
}: {
  apps: readonly AppDef[];
  settings: MenuSections;
}): CommandAction[] {
  return [NEW_PAGE, EDIT_PAGE, INVITE, CONNECT_AGENT, ...appActions(apps), ...settingsActions(settings)].map(
    withShortcutHint,
  );
}

/**
 * A shortcut as `useCommandShortcuts` matches it: the letter lower-cased,
 * after `shift+` when Shift is held (`c`, `shift+k`). Null without one.
 */
export function shortcutId(shortcut: CommandShortcut | undefined): string | null {
  if (!shortcut) return null;
  return `${shortcut.shift ? 'shift+' : ''}${shortcut.key.toLowerCase()}`;
}

/** Whether a shortcut is one a person can press as drawn: one letter, `a` to `z`. */
function isOneLetter(shortcut: CommandShortcut): boolean {
  return typeof shortcut.key === 'string' && /^[a-z]$/i.test(shortcut.key);
}

/**
 * Core's commands, then the registry's — a distribution adds to the list
 * rather than reordering it. A registry command reusing an id core already
 * has is dropped (and said so in the console): two rows with one id would
 * share a DOM id, and the suggestions could not tell them apart. A registry
 * command whose shortcut is not one letter, or takes a key already bound,
 * keeps its row and loses its shortcut, hint included, so the menu never
 * shows a key that does nothing.
 */
export function mergeCommandActions(
  core: readonly CommandAction[],
  extra: readonly CommandAction[],
): CommandAction[] {
  const ids = new Set(core.map((a) => a.id));
  const bound = new Set(core.map((a) => shortcutId(a.shortcut)).filter((s): s is string => s !== null));
  const merged = [...core];
  for (const action of extra) {
    if (ids.has(action.id)) {
      console.error(`[commands] dropping a registry command with a duplicate id: ${action.id}`);
      continue;
    }
    ids.add(action.id);
    if (!action.shortcut) {
      merged.push(action);
      continue;
    }
    // Only what `useCommandShortcuts` can bind is kept: one letter, with or
    // without Shift. Anything else would be drawn and never fire.
    if (!isOneLetter(action.shortcut)) {
      console.error(
        `[commands] the shortcut ${JSON.stringify(action.shortcut)} of ${action.id} is not one letter; it is not bound`,
      );
      merged.push({ ...action, shortcut: undefined });
      continue;
    }
    const id = shortcutId(action.shortcut)!;
    if (bound.has(id)) {
      console.error(`[commands] the shortcut "${id}" of ${action.id} is already bound; it is not bound`);
      merged.push({ ...action, shortcut: undefined });
      continue;
    }
    bound.add(id);
    merged.push(action);
  }
  return merged;
}

/**
 * The commands to offer now. A `visible` that throws costs its own command,
 * never the menu: a registry contribution with a bug must not take the
 * search box down with it.
 */
export function visibleActions(actions: readonly CommandAction[], ctx: CommandContext): CommandAction[] {
  return actions.filter((action) => {
    try {
      return action.visible(ctx);
    } catch (err) {
      console.error(`[commands] visible() threw for ${action.id}:`, err);
      return false;
    }
  });
}

/**
 * What an empty menu offers before anything is typed: a handful of the
 * commonest verbs, not the whole list — Create new page, Invite people (for an
 * admin), Connect your agent while that onboarding is open, and a way to the
 * other app. Drawn from `visible`, so nothing is suggested that is not
 * offered.
 */
export function suggestedActions(visible: readonly CommandAction[], ctx: CommandContext): CommandAction[] {
  const byId = new Map(visible.map((a) => [a.id, a]));
  const ids = ['new-page', 'invite'];
  if (ctx.onboardingPending) ids.push('connect-agent');
  const otherApp = visible.find((a) => a.id.startsWith('go-to:') && a.id !== goToAppActionId(ctx.activeAppId ?? ''));
  if (otherApp) ids.push(otherApp.id);
  return ids.map((id) => byId.get(id)).filter((a): a is CommandAction => a !== undefined);
}

/** What a query is matched against: the label first (the tie-breaker), then the keywords. */
export function actionNames(action: CommandAction): string[] {
  return [action.label, ...(action.keywords ?? [])];
}
