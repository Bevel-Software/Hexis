import { createContext, useContext } from 'react';

export interface LayoutController {
  isExplorerCollapsed: boolean;
  isChatCollapsed: boolean;
  // Layout-specific affordance: the mobile layout pins the chat full-screen and
  // surfaces the explorer as a drawer, so the chat toggle is hidden there. The
  // desktop layout enables a toggle per registered collapsible pane (and
  // `canToggleChat` is false when no chat pane is registered at all).
  canToggleExplorer: boolean;
  canToggleChat: boolean;
  toggleExplorer: () => void;
  toggleChat: () => void;
  // Generalized per-pane API for registry-contributed panes. The named
  // explorer/chat members above are kept as stable aliases for the
  // 'explorer'/'chat' pane ids. Optional so hand-built controllers (tests)
  // remain valid.
  isPaneCollapsed?: (id: string) => boolean;
  canTogglePane?: (id: string) => boolean;
  togglePane?: (id: string) => void;
}

/**
 * Controller for a surface with no collapsible panes — what the shell provides
 * while an app WITHOUT the pane layout (e.g. Skills & Tools) is active, so the
 * always-mounted Toolbar renders no toggle buttons instead of crashing.
 */
export const NO_PANES_LAYOUT: LayoutController = {
  isExplorerCollapsed: false,
  isChatCollapsed: false,
  canToggleExplorer: false,
  canToggleChat: false,
  toggleExplorer: () => {},
  toggleChat: () => {},
  isPaneCollapsed: () => false,
  canTogglePane: () => false,
  togglePane: () => {},
};

export const LayoutContext = createContext<LayoutController | null>(null);

export function useLayout(): LayoutController {
  const ctx = useContext(LayoutContext);
  if (!ctx) throw new Error('useLayout must be used within LayoutContext.Provider');
  return ctx;
}
