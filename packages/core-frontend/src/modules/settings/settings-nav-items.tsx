import { useMemo } from 'react';
import { Boxes, CircleUserRound, KeyRound, Lock, Users } from 'lucide-react';
import { useAppRegistry, type AdminMenuItem } from '../../core/registry';

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
 * registry is empty (`makeRegistry({})`), so the menu is these six rows and no
 * more; the enterprise app gets all thirteen.
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
 * fully supported for registry-contributed rows.
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
    id: 'roles-members',
    section: 'admin',
    order: 10,
    icon: <Users size={15} />,
    label: 'Roles & Members',
    path: '/roles-and-members',
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
 * original bug. `/connect` is outside this set for that reason — it is a flow
 * page with no row, an OAuth landing target whose agent-connect mode has
 * somebody else blocked on a Finish button.
 */
export const SETTINGS_NAV_PATHS: readonly string[] = CORE_MENU_ITEMS.map(
  (item) => item.path,
).filter((path): path is string => !!path);

/**
 * Exact match, never a prefix. These are exact routes, and the nav marks the
 * current row by comparing the whole pathname — a prefix test would light up
 * `/account` for a hypothetical `/accounts-of-other-people`.
 */
export function isSettingsNavPath(pathname: string): boolean {
  return SETTINGS_NAV_PATHS.includes(pathname);
}

export interface MenuSections {
  defaultItems: AdminMenuItem[];
  adminItems: AdminMenuItem[];
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
    const bySection = (section: 'default' | 'admin') =>
      all
        .filter((item) => (item.section ?? 'default') === section)
        .sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
    return { defaultItems: bySection('default'), adminItems: bySection('admin') };
  }, [registry]);
}
