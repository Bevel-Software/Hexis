/**
 * What the layout module offers the other modules. A consumer outside the
 * module imports from here, never from the files: they are the module's own
 * layout and free to move. Export what another module needs; nothing more.
 */
export { SETUP_COLUMN_HIDDEN_QUERY, TOOLBAR_STACK_QUERY } from './breakpoints';
export { useMediaQuery } from './hooks/useMediaQuery';
export { LayoutContext, useLayout } from './state/layout.context';
export { toggleSidebar, useSidebar } from './state/sidebar';
