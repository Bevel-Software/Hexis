import { useContext, useMemo } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { AdminContext } from '../../admin/state/admin.context';
import type { AdminMenuItem } from '../../../core/registry';
import { SidebarFrame } from '../../layout/components/SidebarFrame';
import { useMediaQuery } from '../../layout/hooks/useMediaQuery';
import { isSettingsNavPath, useMenuSections } from '../settings-nav-items';
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
 * Knowledge's file tree and Skills & Tools' group list. `sidebar.ts` already
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
 */
function linkable(items: AdminMenuItem[]): LinkableItem[] {
  return items.filter(
    (item): item is LinkableItem => !!item.path && isSettingsNavPath(item.path),
  );
}

export function SettingsLayout() {
  const { pathname } = useLocation();
  // Not `useAdmin()` — see (2) above.
  const isAdmin = useContext(AdminContext)?.isAdmin ?? false;
  const { defaultItems, adminItems } = useMenuSections();
  /* Below `md` the sidebar frame is not mounted AT ALL and the rows become a
     horizontal strip. A 212px rail on a 375px screen is most of the screen. */
  const isCompact = useMediaQuery('(max-width: 767px)');

  const navDefault = useMemo(() => linkable(defaultItems), [defaultItems]);
  const navAdmin = useMemo(
    () => (isAdmin ? linkable(adminItems) : []),
    [adminItems, isAdmin],
  );

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
            adminItems={navAdmin}
            currentPath={pathname}
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
          adminItems={navAdmin}
          currentPath={pathname}
        />
      </SidebarFrame>
      <main className="min-w-0 flex-1">
        <Outlet />
      </main>
    </div>
  );
}
