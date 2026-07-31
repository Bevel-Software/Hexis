import type { ReactNode } from 'react';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { ResizableThreePaneLayout } from './ResizableThreePaneLayout';
import { MobileChatLayout } from './MobileChatLayout';
import type { LayoutController } from '../state/layout.context';
import type { PaneDef } from '../../../core/registry';

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
  // Legacy named slots, kept as a convenience/compat signature.
  explorer?: ReactNode;
  viewer?: ReactNode;
  chat?: ReactNode;
}

// Tailwind's `md` breakpoint. Below this width the three-pane layout is
// unusable, so we swap in the chat-first mobile layout.
const MOBILE_QUERY = '(max-width: 767px)';

export function AppLayout(props: AppLayoutProps) {
  const isMobile = useMediaQuery(MOBILE_QUERY);
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
