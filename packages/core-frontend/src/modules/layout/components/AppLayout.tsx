import type { ReactNode } from 'react';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { ResizableThreePaneLayout } from './ResizableThreePaneLayout';
import { MobileChatLayout } from './MobileChatLayout';
import type { LayoutController } from '../state/layout.context';
import type { PaneDef } from '../../../core/registry';
import { TOOLBAR_STACK_QUERY } from '../breakpoints';

interface AppLayoutProps {
  /** Optional now that the Toolbar lives above the app surfaces in the shell. */
  header?: ReactNode;
  /** Registry-driven pane list (preferred). */
  panes?: PaneDef[];
  /**
   * Reports the pane controller to an ancestor provider (the shell), so a
   * toolbar OUTSIDE this layout can drive the pane toggles. Called with null
   * on unmount (app switched away → no panes to toggle).
   */
  onController?: (controller: LayoutController | null) => void;
  /**
   * Pinned above the sidebar's content. Supplied by the shell (the
   * composition root), so this module never names a domain component — see
   * `SidebarFrame`'s `header`.
   */
  sidebarHeader?: ReactNode;
  // Legacy named slots, kept as a convenience/compat signature.
  explorer?: ReactNode;
  viewer?: ReactNode;
  chat?: ReactNode;
}

/**
 * Picks the layout the viewport can actually hold: the resizable three-pane
 * split, or the chat-first mobile one once the panes stop fitting side by
 * side.
 *
 * The swap is conditional on a 'chat' pane existing at all — a core-only build
 * has no chat to pin full-screen, so it stays on the resizable layout at every
 * width rather than falling into a mobile layout with an empty main pane.
 */
export function AppLayout(props: AppLayoutProps) {
  const isMobile = useMediaQuery(TOOLBAR_STACK_QUERY);
  // The mobile layout pins the chat pane full-screen, so it only makes sense
  // when a 'chat' pane is registered at all; without one (core-only builds)
  // the resizable layout is used at every width.
  const hasChatPane = props.panes
    ? props.panes.some((p) => p.id === 'chat')
    : props.chat !== undefined;
  const Layout =
    isMobile && hasChatPane ? MobileChatLayout : ResizableThreePaneLayout;
  return <Layout {...props} />;
}
