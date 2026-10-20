/**
 * Layout's public surface: the app frame and its banners, the layout and
 * sidebar state, and the breakpoints every screen agrees on. Other modules
 * import these from here rather than reaching into layout's files.
 */
export { NARROW_QUERY, SETUP_COLUMN_HIDDEN_QUERY, TOOLBAR_STACK_QUERY } from './breakpoints';
export { AppLayout } from './components/AppLayout';
export { DemoBanner } from './components/DemoBanner';
export { MaintenanceOverlay } from './components/MaintenanceOverlay';
export { ReadOnlyBanner } from './components/ReadOnlyBanner';
export { SIDEBAR_CHILD_INDENT, SIDEBAR_ROW_INSET, SidebarFrame } from './components/SidebarFrame';
export { SidebarToggle } from './components/SidebarToggle';
export { useMediaQuery } from './hooks/useMediaQuery';
export {
  LayoutContext,
  type LayoutController,
  NO_PANES_LAYOUT,
  useLayout,
} from './state/layout.context';
export { setSidebarCollapsed, toggleSidebar, useSidebar } from './state/sidebar';
