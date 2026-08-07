import { Fragment, useMemo } from 'react';
import { useLocation } from 'react-router-dom';
import { PanelRight } from 'lucide-react';
import { ProfileMenu } from './ProfileMenu';
import { AppSwitcher } from './AppSwitcher';
import { useLayout } from '../../layout/state/layout.context';
import { useMediaQuery } from '../../layout/hooks/useMediaQuery';
import { useAppRegistry } from '../../../core/registry';
import { SidebarToggle } from '../../layout/components/SidebarToggle';
import { toggleSidebar, useSidebar } from '../../layout/state/sidebar';
import { LIBRARY_ROOT } from '../../library/routes/library-paths';
import { TOOLBAR_STACK_QUERY } from '../../layout/breakpoints';
import { isSettingsNavPath } from '../../settings/settings-nav-items';

/**
 * The app's top bar: the nav toggle, the app switcher, and whatever the
 * registry contributes beside them.
 *
 * It lives in the shell ABOVE the app surfaces rather than inside either one,
 * which is why the nav toggle survives a switch between Knowledge and Skills &
 * Tools instead of being re-mounted by each.
 */
export function Toolbar() {
  const registry = useAppRegistry();
  const location = useLocation();
  /**
   * ONE nav toggle, for the app's ONE sidebar.
   *
   * There used to be two buttons here — a path-gated `SidebarToggle` for the
   * Library and a registry-gated one for Knowledge's explorer — with the same
   * glyph, in the same spot, driving two different pieces of state. They read
   * as one control to anyone using the app, so now they are one.
   *
   * Which surfaces HAVE a sidebar is asked three ways, because they answer it
   * differently: Knowledge declares a `sidebar` pane (so the layout controller
   * can say `canToggleExplorer`), while Skills & Tools and the settings pages
   * have no pane group at all and are identified by their paths.
   *
   * The settings clause is `&& !isCompact` because below `md` the settings
   * layout mounts no `SidebarFrame` at all — the nav is a strip inside the
   * page — and a toggle there would point `aria-controls` at an element that
   * does not exist.
   */
  const onLibrary =
    location.pathname === LIBRARY_ROOT || location.pathname.startsWith(`${LIBRARY_ROOT}/`);
  const { collapsed: sidebarCollapsed } = useSidebar();
  const { isChatCollapsed, canToggleExplorer, canToggleChat, toggleChat } = useLayout();
  // Below the `md` breakpoint the registry item cluster (the enterprise
  // branch switcher, for one) does not fit alongside the toolbar essentials,
  // so it drops onto a second row instead of overflowing offscreen.
  const isCompact = useMediaQuery(TOOLBAR_STACK_QUERY);
  const hasSidebar =
    onLibrary || canToggleExplorer || (isSettingsNavPath(location.pathname) && !isCompact);

  // Registry-contributed left-cluster items. The CORE toolbar has none of its
  // own: the branch switcher is an enterprise contribution scoped (by the
  // item itself, via useActiveAppId) to the Knowledge app — the git module
  // still ships the component, the core shell just doesn't mount it.
  // (Share/Discard buttons retired with the workflow migration: lock release
  // auto-commits + pushes, so there is no separate "share" step.)
  const toolbarItems = useMemo(
    () =>
      [...registry.toolbarItems].sort((a, b) => (a.order ?? 100) - (b.order ?? 100)),
    [registry],
  );
  const itemCluster = toolbarItems.map((item) => (
    <Fragment key={item.id}>{item.node}</Fragment>
  ));

  return (
    <header className="border-b border-line shrink-0 bg-white">
      <div className="h-12 flex items-center px-4 gap-2">
        {hasSidebar && (
          <SidebarToggle collapsed={sidebarCollapsed} onToggle={toggleSidebar} />
        )}

        <AppSwitcher />

        {!isCompact && itemCluster.length > 0 && (
          <div className="flex items-center gap-2 ml-4">{itemCluster}</div>
        )}

        <div className="flex-1" />

        {canToggleChat && (
          <button
            onClick={toggleChat}
            className={`p-1.5 rounded hover:bg-hover transition-colors ${
              isChatCollapsed ? 'text-ink-muted' : 'text-ink'
            }`}
            title={isChatCollapsed ? 'Show chat panel' : 'Hide chat panel'}
            aria-label={isChatCollapsed ? 'Show chat panel' : 'Hide chat panel'}
            aria-pressed={!isChatCollapsed}
          >
            <PanelRight size={16} />
          </button>
        )}

        {/* One button for who you are and everything that follows you around.
            It used to be three things in a row here — a name that was not a
            control, a gear, and a sign-out arrow — all answering the same
            question. See ProfileMenu's docblock. */}
        <ProfileMenu />
      </div>

      {isCompact && itemCluster.length > 0 && (
        <div
          // Horizontal-only scroll. `overflow-y-hidden` keeps a tall child
          // (e.g. a button with a wrapping badge) from giving the row a
          // vertical scrollbar, and `touch-action: pan-x` tells touch
          // browsers not to claim a vertical pan gesture on this strip —
          // otherwise iOS / Android can hijack downward swipes that started
          // on the toolbar.
          className="h-10 flex items-center px-3 gap-2 border-t border-line overflow-x-auto overflow-y-hidden"
          style={{ touchAction: 'pan-x' }}
        >
          {itemCluster}
        </div>
      )}

    </header>
  );
}
