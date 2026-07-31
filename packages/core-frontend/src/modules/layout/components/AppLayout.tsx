import type { ReactNode } from 'react';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { ResizableThreePaneLayout } from './ResizableThreePaneLayout';
import { MobileChatLayout } from './MobileChatLayout';
import type { PaneDef } from '../../../core/registry';

interface AppLayoutProps {
  header: ReactNode;
  /** Registry-driven pane list (preferred). */
  panes?: PaneDef[];
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
