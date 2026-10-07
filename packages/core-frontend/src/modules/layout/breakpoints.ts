/** A fixed sidebar no longer fits beside the page at or below this width. */
export const NARROW_PX = 900;
export const NARROW_QUERY = `(max-width: ${NARROW_PX}px)`;

/** The toolbar's contributed item cluster needs its own row at this width. */
export const TOOLBAR_STACK_QUERY = '(max-width: 767px)';

/**
 * The "Get set up" column (288px) stops fitting beside an app surface at or
 * below this width: the sidebar plus a readable page already take the rest.
 */
export const SETUP_COLUMN_HIDDEN_QUERY = '(max-width: 1100px)';
