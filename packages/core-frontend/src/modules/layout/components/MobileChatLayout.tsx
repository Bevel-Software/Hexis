import { useCallback, useEffect, useMemo, type ReactNode } from 'react';
import { useLocation, useMatch, useNavigate } from 'react-router-dom';
import { X } from 'lucide-react';
import { LayoutContext, type LayoutController } from '../state/layout.context';
import { KB_ROUTE_PREFIX, kbFileUrl } from '../../workspace/routing/kb-routes';
import { SlideOverlay } from './SlideOverlay';
import { SidebarFrame } from './SidebarFrame';
import {
  setSidebarCollapsed,
  toggleSidebar,
  useSidebar,
} from '../state/sidebar';
import type { PaneDef } from '../../../core/registry';

interface MobileChatLayoutProps {
  header?: ReactNode;
  /** Reports the pane controller upward (null on unmount) — see AppLayout. */
  onController?: (controller: LayoutController | null) => void;
  /** Pinned above the explorer contents inside the shared sidebar frame. */
  sidebarHeader?: ReactNode;
  /**
   * Registry-driven pane list (preferred). This layout is chat-first, so it
   * picks the well-known 'explorer' / 'viewer' / 'chat' panes out of the
   * list — AppLayout only selects it when a 'chat' pane is registered.
   */
  panes?: PaneDef[];
  // Legacy named slots, kept as a convenience/compat signature.
  explorer?: ReactNode;
  viewer?: ReactNode;
  chat?: ReactNode;
}

/**
 * The phone layout: chat holds the screen, and the other two panes arrive over
 * it — the explorer as the shared sidebar drawer, the viewer as a slide-over
 * sheet — so there is always exactly one thing to read.
 *
 * The explorer goes through `SidebarFrame` rather than a drawer of its own,
 * which is what makes the toolbar's nav toggle mean the same thing here as it
 * does on desktop.
 */
export function MobileChatLayout({
  header,
  panes,
  onController,
  sidebarHeader,
  explorer: explorerSlot,
  viewer: viewerSlot,
  chat: chatSlot,
}: MobileChatLayoutProps) {
  const explorer = panes
    ? panes.find((p) => p.id === 'explorer')?.node
    : explorerSlot;
  const viewer = panes ? panes.find((p) => p.id === 'viewer')?.node : viewerSlot;
  const chat = panes ? panes.find((p) => p.id === 'chat')?.node : chatSlot;
  const { collapsed: isExplorerCollapsed } = useSidebar();
  const location = useLocation();
  const navigate = useNavigate();

  // Auto-close the explorer drawer whenever the URL changes (e.g. user tapped
  // a file in the tree). Without this the drawer would stay open over the chat
  // and obscure the viewer sheet that's about to slide in.
  const pathname = location.pathname;
  useEffect(() => {
    setSidebarCollapsed(true);
  }, [pathname]);

  // Chat is always full-screen on mobile, so its toggle is hidden and the
  // collapse flag is locked to false. Toggle is a no-op to satisfy the contract.
  const noopToggleChat = useCallback(() => {}, []);

  const controller = useMemo<LayoutController>(
    () => ({
      isExplorerCollapsed,
      isChatCollapsed: false,
      canToggleExplorer: true,
      canToggleChat: false,
      toggleExplorer: toggleSidebar,
      toggleChat: noopToggleChat,
    }),
    [isExplorerCollapsed, noopToggleChat],
  );

  // Mirror the controller to the shell (whose provider wraps the toolbar) —
  // same object as the inner provider below, so the two stay consistent.
  useEffect(() => {
    onController?.(controller);
    return () => onController?.(null);
  }, [controller, onController]);

  // Viewer sheet visibility is URL-driven: open iff the URL is on the KB route
  // AND points at a file (the `*` segment is non-empty). Closing the sheet
  // navigates back to the branch root, which the same match treats as closed.
  //
  // `useMatch` returns params already URI-decoded (React Router v6+), so use
  // them as-is — re-decoding would throw URIError on legitimate names like
  // `release-50%` whose URL form is `release-50%25`.
  const match = useMatch(`${KB_ROUTE_PREFIX}/:branch/*`);
  const branch = match?.params.branch ?? null;
  const filePath = match?.params['*'] ?? '';
  const isViewerOpen = !!branch && filePath.length > 0;

  const closeViewer = useCallback(() => {
    if (!branch) return;
    navigate(kbFileUrl(branch));
  }, [branch, navigate]);

  return (
    <LayoutContext.Provider value={controller}>
      <div className="flex flex-col h-full bg-white text-ink">
        {header}
        <div className="flex-1 min-h-0">
          {chat}
        </div>
      </div>

      <SidebarFrame label="File explorer" header={sidebarHeader}>
        {explorer}
      </SidebarFrame>

      <SlideOverlay
        open={isViewerOpen}
        onClose={closeViewer}
        side="bottom"
        ariaLabel="File preview"
        panelClassName="h-[92vh] rounded-t-2xl flex flex-col"
        swipeToClose
      >
        {/* The drag-handle area is a sibling of the close button, not its
            ancestor. SlideOverlay's `closest('[data-swipe-handle="true"]')`
            check therefore only fires when the gesture starts on the grip
            zone — taps on the close button walk up past a header that does
            NOT carry the attribute and so don't initiate a drag. */}
        <div className="h-9 flex items-center px-2 shrink-0 border-b border-line">
          <div
            data-swipe-handle="true"
            className="flex-1 self-stretch flex items-center justify-center cursor-grab touch-none"
            aria-label="Swipe down to close"
          >
            <div className="w-10 h-1 rounded-full bg-line-strong" aria-hidden="true" />
          </div>
          <button
            type="button"
            onClick={closeViewer}
            className="p-1.5 rounded hover:bg-hover text-ink-muted hover:text-ink"
            title="Close file"
            aria-label="Close file"
          >
            <X size={16} />
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-hidden">
          {isViewerOpen ? viewer : null}
        </div>
      </SlideOverlay>
    </LayoutContext.Provider>
  );
}
