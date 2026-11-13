import { useMemo } from 'react';
import { matchRoutes } from 'react-router-dom';
import { Boxes, CircleUserRound, KeyRound, Lock, ScrollText, SlidersHorizontal, Users, UsersRound } from 'lucide-react';
import { useAppRegistry, type AdminMenuItem, type AppRegistry } from '../../core/registry';

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

/**
 * The route patterns the shell answers itself, besides the settings pages
 * above and the apps: the old Connection keys address and `/connect` (both
 * redirects), the landing routes (`/`, `/auth/*`), a change request's link,
 * and the two embed pages that sit outside the app. The shell's catch-all is
 * not here: it owns no address in particular.
 *
 * Written out, because the shell imports this module and not the other way
 * round. `ShellRoutes.test.tsx` reads the route table of `ShellRoutes` and
 * holds this list to it, so a route added there without its pattern here
 * fails. The two embed pages are mounted above `ShellRoutes` and are listed
 * by hand.
 */
const SHELL_OWN_ROUTES: readonly string[] = [
  '/connection-keys',
  '/connect',
  '/',
  '/auth/*',
  '/change-requests/:number',
  '/embed',
  '/embed/link',
];

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
 * The registry's rows that bring a settings page (see `AdminMenuItem.page`),
 * each with its path normalized.
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
    ...SHELL_OWN_ROUTES,
    ...registry.apps.filter((app) => app.path !== '/').map((app) => `${app.path}/*`),
    ...registry.topLevelRoutes.map((route) => route.path),
  ];
  for (const item of registry.adminMenuItems) {
    if (!item.path) continue;
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
