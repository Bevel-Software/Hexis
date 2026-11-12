import { useContext, useMemo } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { AdminContext } from '../../admin';
import { useAppRegistry, type AdminMenuItem } from '../../../core/registry';
import { SidebarFrame } from '../../layout/components/SidebarFrame';
import { useMediaQuery } from '../../layout';
import { AuthContext } from '../../auth';
import type { AuthUser } from '@bevel-software/platform-shared';
import {
  isSettingsNavPath,
  normalizeSettingsPath,
  registrySettingsPages,
  useMenuSections,
  useSettingsNavPaths,
} from '../settings-nav-items';
import { SettingsNav, type LinkableItem } from './SettingsNav';

/**
 * The settings surfaces, wrapped in the nav that reaches them.
 *
 * The settings pages used to be reachable ONLY from the profile dropdown,
 * which closes on the way out — so getting from Secrets to Account meant
 * finding a 22px avatar in the far corner and re-summoning a list. The list
 * looked like a nav and behaved like a menu. This makes it a nav: mounted by
 * the route table, so it is a property of being a settings page rather than
 * something each page has to remember to render.
 *
 * It fills the app's ONE `SidebarFrame` — the third renderer of it, after
 * Knowledge's file tree and Skills & Tools' plugin list. `sidebar.ts` already
 * states the claim this relies on: there is one nav, in one place, holding a
 * different list depending on where you are.
 *
 * Three things here are load-bearing and easy to undo by accident:
 *
 *  1. NO `key={pathname}` anywhere. React Router keeps a layout element
 *     mounted across sibling child-route changes, and that is exactly what
 *     makes the nav persistent — the collapse state survives `/secrets` →
 *     `/account`, focus survives the click, and the child page mounts fresh
 *     without the layout blinking. A key here would remount all of it and
 *     reintroduce the bug in a subtler form.
 *
 *  2. `useContext(AdminContext)` directly, never `useAdmin()`. That hook
 *     throws outside `AdminProvider`, and the shell's route tests render
 *     `ShellRoutes` with no providers at all. Reading the context is honest
 *     rather than a dodge: this nav is WAYFINDING, not the security boundary
 *     — the backend gates every roles/accounts endpoint and each admin page
 *     renders its own "Admins only" notice — and no-context reading as "not
 *     an admin" is precisely `AdminProvider`'s own starting state.
 *
 *  3. `<main>` is NOT the scroller, which is the one deliberate departure
 *     from `LibraryLayout`. All six pages below already own a full-height
 *     scrolling container (`PageShell` is `h-full overflow-y-auto`), so
 *     scrolling here too would nest two scrollers and float the scrollbar
 *     off the page's own edge.
 */
/**
 * A row can be shown only if it declares where it goes AND that destination is
 * one of the routes this layout wraps.
 *
 * The first half excludes dialog rows — a dialog has no URL, so it can be
 * neither linked to nor marked current. The second excludes a registry row
 * pointing somewhere else in the app: a settings nav that could navigate you
 * into Knowledge would be a nav that replaces itself mid-click. Neither kind
 * is lost; both keep working in the dropdown, which is the surface that can
 * run arbitrary actions.
 *
 * Module scope, not a closure inside the component: it captures nothing, and
 * as a closure it was a dependency the memos below had to either list (and
 * rebuild on every render) or lie about.
 *
 * The surviving rows come out NORMALIZED, so both halves of the current-row
 * comparison are spelled the same way — the pathname is normalized on its way
 * in, and a registry row that happened to declare `/secrets/` would otherwise
 * render a link that never matches the page it is on.
 */
function linkable(items: AdminMenuItem[], paths: readonly string[], mountedPages: ReadonlySet<string>): LinkableItem[] {
  return items
    .filter((item): item is LinkableItem => !!item.path && isSettingsNavPath(item.path, paths))
    // A row that does something when picked belongs to the dropdown: there its
    // action wins over its `path`, and a link here would go around the action.
    .filter((item) => !item.dialog && !item.onSelect)
    // A row that brings a page is linked only when its page is the one mounted
    // at that path: one that lost the address to a built-in page, or to an
    // earlier row, would be a link to somebody else's page under its own name.
    .filter((item) => !item.page || mountedPages.has(item.id))
    .map((item) => ({ ...item, path: normalizeSettingsPath(item.path) }));
}

/**
 * The rows offered to this person (`AdminMenuItem.isShown`): with nobody
 * signed in, none of the rows that ask who is. Asked on every render, never
 * memoized, as the profile menu asks: a row may come and go with state the
 * layout does not own (a role learnt after sign-in, a preference in storage).
 */
function offered<T extends AdminMenuItem>(items: T[], user: AuthUser | null): T[] {
  return items.filter((item) => !item.isShown || (user !== null && item.isShown(user)));
}

export function SettingsLayout() {
  // Normalized, because the row paths are — see `normalizeSettingsPath`. The
  // page renders at `/secrets/` either way; without this its row is the only
  // one in the nav that is never marked current.
  const currentPath = normalizeSettingsPath(useLocation().pathname);
  // Not `useAdmin()` — see (2) above.
  const isAdmin = useContext(AdminContext)?.isAdmin ?? false;
  // The same reading for the person: the nav is wayfinding, and nobody signed in is nobody a role's rows are for.
  const user = useContext(AuthContext)?.user ?? null;
  const { defaultItems, adminItems, appSections } = useMenuSections();
  // Core's paths and the pages the registry's rows bring (`AdminMenuItem.page`).
  const paths = useSettingsNavPaths();
  /* Below `md` the sidebar frame is not mounted AT ALL and the rows become a
     horizontal strip. A 212px rail on a 375px screen is most of the screen. */
  const isCompact = useMediaQuery('(max-width: 767px)');

  // The registry's rows whose page is mounted, by id: what a row that brings a page must be among to be linked.
  const registry = useAppRegistry();
  const mountedPages = useMemo(() => new Set(registrySettingsPages(registry.adminMenuItems).map((row) => row.id)), [registry]);

  const linkDefault = useMemo(() => linkable(defaultItems, paths, mountedPages), [defaultItems, paths, mountedPages]);
  const linkAdmin = useMemo(
    () => (isAdmin ? linkable(adminItems, paths, mountedPages) : []),
    [adminItems, isAdmin, paths, mountedPages],
  );
  const linkSections = useMemo(
    () => appSections.map((section) => ({ id: section.id, label: section.label, items: linkable(section.items, paths, mountedPages) })),
    [appSections, paths, mountedPages],
  );
  // Who each row is offered to is asked now, on this render (see `offered`).
  const navDefault = offered(linkDefault, user);
  const navAdmin = offered(linkAdmin, user);
  // The app's own sections ("Infrastructure only"), each with the pages offered to this person; one with none is left out.
  const navSections = linkSections
    .map((section) => ({ ...section, items: offered(section.items, user) }))
    .filter((section) => section.items.length > 0);

  if (isCompact) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-canvas text-ink">
        {/* Horizontal-only scroll, the same idiom (and the same reasons) as
            the toolbar's compact item cluster: `overflow-y-hidden` stops a
            tall row growing a vertical scrollbar, and `pan-x` stops touch
            browsers claiming a downward swipe that started on the strip. */}
        <div
          className="shrink-0 border-b border-line bg-sidebar px-3 py-2 overflow-x-auto overflow-y-hidden"
          style={{ touchAction: 'pan-x' }}
        >
          <SettingsNav
            defaultItems={navDefault}
            sections={navSections}
            adminItems={navAdmin}
            currentPath={currentPath}
            orientation="strip"
          />
        </div>
        <main className="min-h-0 flex-1">
          <Outlet />
        </main>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 bg-canvas text-ink">
      <SidebarFrame label="Settings">
        <SettingsNav
          defaultItems={navDefault}
          sections={navSections}
          adminItems={navAdmin}
          currentPath={currentPath}
        />
      </SidebarFrame>
      <main className="min-w-0 flex-1">
        <Outlet />
      </main>
    </div>
  );
}
