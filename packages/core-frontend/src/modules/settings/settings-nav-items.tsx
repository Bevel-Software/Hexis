import { useMemo } from 'react';
import { matchRoutes } from 'react-router-dom';
import { Boxes, CircleUserRound, KeyRound, Lock, ScrollText, SlidersHorizontal, Users, UsersRound } from 'lucide-react';
import { useAppRegistry, type AdminMenuItem, type AppRegistry } from '../../core/registry';
import { SHELL_PATHS } from '../../core/shell-paths';

/**
 * The settings rows, and the one merge that orders them.
 *
 * This module exists so the profile dropdown and the settings nav read from
 * ONE list. They are two renderers of the same set — the dropdown is the door,
 * the nav is where you are once you are inside — and two lists would drift the
 * first time somebody added a row to whichever file they had open.
 *
 * It deliberately does NOT live under `modules/workspace`: the design-system
 * parity test walks that directory specifically.
 */

/**
 * The core menu rows. Everything else (Connectors, Watchlist, Routines,
 * Connected apps, feedback, LLM configuration, …) is registry-contributed —
 * see the enterprise shell's `adminMenuItems`. The `order` values interleave
 * the two lists to reproduce the historical row order. In THIS repo the
 * registry is empty (`makeRegistry({})`), so the menu is these rows plus the
 * core modules' own action rows the shell merges in (git's "Ask before
 * deleting branches", while it applies); the enterprise app gets all thirteen.
 *
 * Skills & Tools is deliberately NOT here. It is an APP (see `CORE_APPS` in
 * CoreAppShell), and apps belong to the app switcher — which already lists it
 * and marks it as current. Listing it here too made one destination answerable
 * from two different menus, and only one of them could show you were already
 * in it. Do not re-add it.
 *
 * Every core row is DATA: a `path`, not an `onSelect` closure that navigates
 * to one. The closures said the same thing twice — where the row goes, and how
 * to go there — and only the second half was legible to anything that was not
 * a click. The `dialog` and `onSelect` contracts on {@link AdminMenuItem} stay
 * fully supported for rows that arrive through the registry — and not every
 * such row is the enterprise shell's: `CoreAppShell` merges core modules' own
 * action rows into `registry.adminMenuItems` (git's "Ask before deleting
 * branches", an `onSelect` row with no `path`, which therefore never reaches
 * the settings nav).
 */
export const CORE_MENU_ITEMS: AdminMenuItem[] = [
  {
    id: 'external-agent-access',
    order: 40,
    icon: <KeyRound size={15} />,
    label: 'External agent access',
    path: '/external-agent-access',
  },
  {
    // Everyone's row, not an admin's: each person sees their own agents and
    // keys and what those called; admins see every account on the same page.
    // It replaced the admin-only Connection keys row.
    id: 'audit-log',
    order: 45,
    icon: <ScrollText size={15} />,
    label: 'Audit log',
    path: '/audit-log',
  },
  {
    id: 'secrets',
    order: 50,
    icon: <Lock size={15} />,
    label: 'Secrets',
    path: '/secrets',
  },
  {
    id: 'browse-tools',
    order: 70,
    icon: <Boxes size={15} />,
    label: 'Browse available tools',
    path: '/tools',
  },
  {
    id: 'account',
    order: 90,
    icon: <CircleUserRound size={15} />,
    label: 'Account',
    path: '/account',
  },
  {
    id: 'deployment',
    section: 'admin',
    order: 5,
    icon: <SlidersHorizontal size={15} />,
    label: 'Deployment',
    path: '/deployment',
  },
  {
    id: 'roles-members',
    section: 'admin',
    order: 10,
    icon: <Users size={15} />,
    label: 'App roles',
    path: '/roles-and-members',
  },
  {
    id: 'directory-groups',
    section: 'admin',
    order: 15,
    icon: <UsersRound size={15} />,
    label: 'Groups & Members',
    path: '/directory-groups',
  },
  {
    id: 'user-accounts',
    section: 'admin',
    order: 20,
    icon: <CircleUserRound size={15} />,
    label: 'User accounts',
    path: '/user-accounts',
  },
];

/**
 * The routes {@link SettingsLayout} wraps, and the gate the toolbar uses to
 * decide whether this surface has a sidebar to toggle.
 *
 * DERIVED from the rows above rather than written out again. These were the
 * same six strings in two places, and two places is where a seventh settings
 * page gets added to one of them: the row would appear in the dropdown, and
 * the page it opened would have no nav and no toggle — exactly the bug this
 * module exists to prevent, reintroduced one route at a time.
 *
 * The consequence is a rule worth having: a settings page reaches the nav by
 * having a row, and a settings page with no way to navigate to it is the
 * original bug. "Connect your tools" is outside this set for that reason — it
 * is a flow page with no row, an OAuth landing target whose agent-connect mode
 * has somebody else blocked on a Finish button — and lives in Skills & Tools.
 */
export const SETTINGS_NAV_PATHS: readonly string[] = CORE_MENU_ITEMS.map(
  (item) => item.path,
).filter((path): path is string => !!path);

/**
 * `/secrets/` and `/secrets` are the SAME destination, so they must compare
 * equal here.
 *
 * React Router already treats them as one: `compilePath` ends an `end: true`
 * pattern with `\/*$`, so the route declared `/secrets` matches both and the
 * page renders either way. But `useLocation().pathname` reports the URL as it
 * actually is, trailing slash included — and everything below compares that
 * string against the paths above. Untreated, arriving at `/secrets/` (a typed
 * URL, an old bookmark, an OAuth redirect that appended one) gives you the
 * settings page with no sidebar toggle in the toolbar and no row marked
 * current: the page renders, its navigation does not.
 *
 * Root keeps its slash. Stripping `/` leaves the empty string, which is not a
 * path — and no settings row is at the root anyway.
 */
export function normalizeSettingsPath(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
}

/** A registry row that is a settings page of the app's own: it says where it lives and what is there. */
export type SettingsPageRow = AdminMenuItem & { path: string; page: NonNullable<AdminMenuItem['page']> };

/** What of the registry decides which settings pages are mounted: the rows, and everything else that answers an address. */
export type SettingsPagesSource = Pick<AppRegistry, 'adminMenuItems' | 'apps' | 'topLevelRoutes'>;

/**
 * Whether the route at `path` answers `pathname`, by the router itself: React
 * Router's `matchRoutes` over that one route, so decoding (`/%65xecutors` is
 * `/executors`), case and a trailing slash (`/Secrets/` is `/secrets`), and a
 * pattern's parameters and splat count exactly as they count when the route
 * is chosen. Every comparison of a settings path goes through here, so which
 * page the router shows, which page is mounted, which row is listed and which
 * row is marked current cannot disagree.
 */
export function sameSettingsPath(path: string, pathname: string): boolean {
  return matchRoutes([{ path }], pathname) !== null;
}

/**
 * Whether a row's `path` is ONE absolute address, written the way everything
 * that reads it reads it. A row's path goes to two places: the browser's
 * address bar (through the row's link) and the router's route table (where
 * its page is mounted). It is one address only if both read it back
 * unchanged, each asked with its own parser:
 *
 *  - the browser's URL parser keeps it on this origin with no query and no
 *    fragment, and leaves the path as written (it folds `..` and `.`, turns a
 *    backslash into a slash, drops a tab; an optional segment's `?` is a
 *    query to it, and a relative path gains a slash);
 *  - the path, mounted as a route, answers itself, as written, and nothing
 *    more: no parameter (`:name`) and no splat, the same pathname (the router
 *    folds a doubled slash), and a match at all (a percent-encoded letter
 *    never matches the address it spells).
 */
function isOneAddress(path: string): boolean {
  const origin = 'http://settings.invalid';
  let inBrowser: string;
  try {
    const url = new URL(path, origin);
    if (url.origin !== origin || url.search || url.hash) return false;
    // Decoded for the comparison: the browser percent-encodes a space or an `ü` it is given as written.
    inBrowser = decodeURI(url.pathname);
  } catch {
    return false;
  }
  if (inBrowser !== path) return false;
  const itself = matchRoutes([{ path }], path);
  return itself !== null && itself[0].pathname === path && Object.keys(itself[0].params).length === 0;
}

/**
 * The registry's rows that bring a settings page (see `AdminMenuItem.page`),
 * each with its path normalized. A row whose path is not one absolute address
 * (see `isOneAddress`: a route pattern, a path with a query or a fragment, a
 * relative path, or any spelling the browser or the router would resolve to
 * something else, such as `/teams/../secrets`) is no destination: it brings
 * no page and holds no address.
 *
 * An address belongs to whatever answers it first, and a row's page is
 * mounted only at an address nothing else answers: not one of core's settings
 * pages, not a route the shell answers itself, not an app's surface (its path
 * and everything under it), not a top-level route of the registry, and not a
 * path an earlier row named, whether or not that row brings a page. So a
 * page never takes over a destination that exists, and a row that only points
 * somewhere (a `path` with no page) keeps its destination against a later
 * row's page. An app that claims the root owns no address in particular, like
 * the shell's catch-all.
 */
export function registrySettingsPages(registry: SettingsPagesSource): SettingsPageRow[] {
  const pages: SettingsPageRow[] = [];
  const taken: string[] = [
    ...SETTINGS_NAV_PATHS,
    // The very patterns the shell mounts its own routes at (`core/shell-paths.ts`).
    ...Object.values(SHELL_PATHS),
    ...registry.apps.filter((app) => app.path !== '/').map((app) => `${app.path}/*`),
    ...registry.topLevelRoutes.map((route) => route.path),
  ];
  for (const item of registry.adminMenuItems) {
    // A path that is not one address names no destination: it brings no page and holds no address.
    if (!item.path || !isOneAddress(item.path)) continue;
    const path = normalizeSettingsPath(item.path);
    if (taken.some((other) => sameSettingsPath(other, path))) continue;
    taken.push(path);
    if (item.page) pages.push({ ...item, path, page: item.page });
  }
  return pages;
}

/**
 * Every path the settings layout wraps: core's, and the pages the registry's
 * rows bring. What the toolbar's sidebar toggle goes by.
 */
export function useSettingsNavPaths(): readonly string[] {
  const registry = useAppRegistry();
  return useMemo(() => [...SETTINGS_NAV_PATHS, ...registrySettingsPages(registry).map((row) => row.path)], [registry]);
}

/**
 * Exact match, never a prefix. These are exact routes, and the nav marks the
 * current row by comparing the whole pathname — a prefix test would light up
 * `/account` for a hypothetical `/accounts-of-other-people`. Exact by the
 * router's rule (see `sameSettingsPath`): a trailing slash or another case is
 * a spelling of the same path rather than a different one.
 */
export function isSettingsNavPath(pathname: string, paths: readonly string[] = SETTINGS_NAV_PATHS): boolean {
  return paths.some((path) => sameSettingsPath(path, pathname));
}

/** One of the app's own labelled sections, with its rows sorted. */
export interface AppMenuSection {
  id: string;
  label: string;
  items: AdminMenuItem[];
}

export interface MenuSections {
  defaultItems: AdminMenuItem[];
  adminItems: AdminMenuItem[];
  /** The app's own sections (see `AdminMenuItem.section`), in their order; drawn between the two above. */
  appSections: AppMenuSection[];
}

/**
 * Core rows merged with the registry's, split by section and sorted.
 *
 * The semantics here are frozen, because enterprise `order` values are tuned
 * against these exact defaults: core rows come first in the input array and
 * `Array.prototype.sort` is stable, so a tie resolves core-before-registry;
 * a row with no `section` is a default row; a row with no `order` sorts at 100.
 */
export function useMenuSections(): MenuSections {
  const registry = useAppRegistry();
  return useMemo(() => {
    const all = [...CORE_MENU_ITEMS, ...registry.adminMenuItems];
    const byOrder = (a: AdminMenuItem, b: AdminMenuItem) => (a.order ?? 100) - (b.order ?? 100);
    const bySection = (section: 'default' | 'admin') =>
      all.filter((item) => (item.section ?? 'default') === section).sort(byOrder);
    // The app's sections: one per id, its label and order from the first row naming it.
    const sections = new Map<string, AppMenuSection & { order: number }>();
    for (const item of all) {
      const section = item.section;
      if (typeof section !== 'object') continue;
      const entry = sections.get(section.id) ?? { id: section.id, label: section.label, order: section.order ?? 100, items: [] };
      entry.items.push(item);
      sections.set(section.id, entry);
    }
    const appSections = [...sections.values()]
      .sort((a, b) => a.order - b.order)
      .map(({ id, label, items }) => ({ id, label, items: items.sort(byOrder) }));
    return { defaultItems: bySection('default'), adminItems: bySection('admin'), appSections };
  }, [registry]);
}
