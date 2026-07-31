import { Fragment, useMemo } from 'react';
import { LogOut, PanelLeft, PanelRight } from 'lucide-react';
import { useAuth } from '../../auth/state/auth.context';
import { AdminMenu } from './AdminMenu';
import { AppSwitcher } from './AppSwitcher';
import { useLayout } from '../../layout/state/layout.context';
import { useMediaQuery } from '../../layout/hooks/useMediaQuery';
import { useAppRegistry } from '../../../core/registry';

export function Toolbar() {
  const { user, logout } = useAuth();
  const registry = useAppRegistry();
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
    <header className="border-b border-slate-200 shrink-0 bg-white">
      <div className="h-12 flex items-center px-4 gap-2">
        {canToggleExplorer && (
          <button
            onClick={toggleExplorer}
            className={`p-1.5 rounded hover:bg-slate-100 transition-colors ${
              isExplorerCollapsed ? 'text-slate-600' : 'text-slate-700'
            }`}
            title={isExplorerCollapsed ? 'Show file explorer' : 'Hide file explorer'}
            aria-label={isExplorerCollapsed ? 'Show file explorer' : 'Hide file explorer'}
            aria-pressed={!isExplorerCollapsed}
          >
            <PanelLeft size={16} />
          </button>
        )}

        <AppSwitcher />

        {!isCompact && itemCluster.length > 0 && (
          <div className="flex items-center gap-2 ml-4">{itemCluster}</div>
        )}

        <div className="flex-1" />

        {user && (
          <div className="flex items-center gap-2">
            {user.avatarUrl && (
              <img
                src={user.avatarUrl}
                alt={user.name}
                className="w-6 h-6 rounded-full"
                referrerPolicy="no-referrer"
              />
            )}
            <span className="text-xs text-slate-600 hidden sm:inline">{user.name}</span>
          </div>
        )}

        <AdminMenu />

        {canToggleChat && (
          <button
            onClick={toggleChat}
            className={`p-1.5 rounded hover:bg-slate-100 transition-colors ${
              isChatCollapsed ? 'text-slate-600' : 'text-slate-700'
            }`}
            title={isChatCollapsed ? 'Show chat panel' : 'Hide chat panel'}
            aria-label={isChatCollapsed ? 'Show chat panel' : 'Hide chat panel'}
            aria-pressed={!isChatCollapsed}
          >
            <PanelRight size={16} />
          </button>
        )}

        <button
          onClick={logout}
          className="p-1.5 rounded hover:bg-slate-100 text-slate-600 hover:text-slate-900"
          title="Sign out"
          aria-label="Sign out"
        >
          <LogOut size={16} />
        </button>
      </div>

      {isCompact && itemCluster.length > 0 && (
        <div
          // Horizontal-only scroll. `overflow-y-hidden` keeps a tall child
          // (e.g. a button with a wrapping badge) from giving the row a
          // vertical scrollbar, and `touch-action: pan-x` tells touch
          // browsers not to claim a vertical pan gesture on this strip —
          // otherwise iOS / Android can hijack downward swipes that started
          // on the toolbar.
          className="h-10 flex items-center px-3 gap-2 border-t border-slate-200 overflow-x-auto overflow-y-hidden"
          style={{ touchAction: 'pan-x' }}
        >
          {itemCluster}
        </div>
      )}

    </header>
  );
}
