import { Fragment, useMemo } from 'react';
import { useLocation } from 'react-router-dom';
import { PanelRight } from 'lucide-react';
import { ProfileMenu } from './ProfileMenu';
import { AppSwitcher } from './AppSwitcher';
import { useLayout } from '../../layout/state/layout.context';
import { useMediaQuery } from '../../layout/hooks/useMediaQuery';
import { useAppRegistry } from '../../../core/registry';
import { cn } from '../../../lib/utils';
import { SidebarToggle, PanelGlyph } from '../../library/components/SidebarToggle';
import { useLibrarySidebar } from '../../library/state/sidebar-collapse';
import { LIBRARY_ROOT } from '../../library/routes/library-paths';

export function Toolbar() {
  const registry = useAppRegistry();
  const location = useLocation();
  // The Library's nav toggle, in the top bar left of the brand. Path-gated
  // rather than registry-gated: the button controls the Library's sidebar,
  // so it appears exactly where that sidebar exists and nowhere else.
  const onLibrary =
    location.pathname === LIBRARY_ROOT || location.pathname.startsWith(`${LIBRARY_ROOT}/`);
  const librarySidebar = useLibrarySidebar();
  const {
    isExplorerCollapsed,
    isChatCollapsed,
    canToggleExplorer,
    canToggleChat,
    toggleExplorer,
    toggleChat,
  } = useLayout();
  // Below the `md` breakpoint the registry item cluster (the enterprise
  // branch switcher, for one) does not fit alongside the toolbar essentials,
  // so it drops onto a second row instead of overflowing offscreen.
  const isCompact = useMediaQuery('(max-width: 767px)');

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
        {onLibrary && (
          <SidebarToggle
            collapsed={librarySidebar.collapsed}
            onToggle={librarySidebar.toggle}
          />
        )}

        {canToggleExplorer && (
          <button
            type="button"
            onClick={toggleExplorer}
            className={cn(
              'flex size-7 items-center justify-center rounded-md transition-colors hover:bg-hover hover:text-ink',
              isExplorerCollapsed ? 'text-ink-muted' : 'text-ink',
            )}
            title={isExplorerCollapsed ? 'Show file explorer' : 'Hide file explorer'}
            aria-label={isExplorerCollapsed ? 'Show file explorer' : 'Hide file explorer'}
            aria-pressed={!isExplorerCollapsed}
          >
            {/* The same glyph the Library's nav toggle uses. One control, one
                shape, one spot — on both surfaces. */}
            <PanelGlyph className="size-4" />
          </button>
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
