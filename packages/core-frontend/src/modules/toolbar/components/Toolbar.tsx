import { LogOut, PanelLeft, PanelRight } from 'lucide-react';
import { useAuth } from '../../auth/state/auth.context';
import { AdminMenu } from './AdminMenu';
import { BranchSwitcher } from '../../git/components/BranchSwitcher';
import { useLayout } from '../../layout/state/layout.context';
import { useMediaQuery } from '../../layout/hooks/useMediaQuery';

export function Toolbar() {
  const { user, logout } = useAuth();
  const {
    isExplorerCollapsed,
    isChatCollapsed,
    canToggleExplorer,
    canToggleChat,
    toggleExplorer,
    toggleChat,
  } = useLayout();
  // Below the `md` breakpoint the git-action cluster (just the branch
  // switcher now) does not fit alongside the toolbar essentials, so it
  // drops onto a second row instead of overflowing offscreen.
  const isCompact = useMediaQuery('(max-width: 767px)');

  // Share + Discard buttons retired with the workflow migration: lock
  // release auto-commits + pushes the file (`releaseLock` in
  // WorkflowService), and all users on the same branch share the same
  // workspace so there is no separate "share" step. The save-state
  // badge that used to live next to the branch switcher was also
  // removed — the per-file Edit/Save toggle on the file viewer is the
  // only state the user needs to act on; a toolbar-level "Saved"
  // indicator added noise without informing any decision.
  const gitActions = <BranchSwitcher />;

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

        <span className="text-sm font-semibold tracking-wide">Bevel</span>

        {!isCompact && (
          <div className="flex items-center gap-2 ml-4">{gitActions}</div>
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

      {isCompact && (
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
          {gitActions}
        </div>
      )}

    </header>
  );
}
