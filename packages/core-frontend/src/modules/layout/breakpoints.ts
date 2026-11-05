/** A fixed sidebar no longer fits beside the page at or below this width. */
export const NARROW_PX = 900;
export const NARROW_QUERY = `(max-width: ${NARROW_PX}px)`;

/** The toolbar's contributed item cluster needs its own row at this width. */
export const TOOLBAR_STACK_QUERY = '(max-width: 767px)';

/**
 * The "Get set up" column (288px) is put away at the same width the sidebar
 * turns into a drawer. It used to go at 1100px, which hid it in an ordinary
 * laptop browser window, the screen it is most for; from 901px up the
 * sidebar, the page and the column still fit side by side.
 */
export const SETUP_COLUMN_HIDDEN_QUERY = NARROW_QUERY;
