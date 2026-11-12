/**
 * Room at the right end of a viewer's toolbar for the full-screen exit control.
 *
 * In full screen, FileViewer marks the read pane `data-full-screen` and pins
 * the exit control (28px square) to the window's top right corner, level with
 * the first row of a full-bleed viewer (`FULL_BLEED_FULL_SCREEN_SURFACE`). A
 * toolbar that ends in actions, like a PDF's or a spreadsheet's Download,
 * takes this class so that its last action stops short of the control by the
 * toolbar's own 8px gap: the two read as one row, Download then exit, and the
 * control covers nothing. Outside full screen the class matches nothing.
 *
 * 36px (`pr-9`) is the control's 28px plus that 8px gap.
 *
 * Its own module so the renderers can take it without importing a component
 * file, and so the components files keep exporting components only.
 */
export const FULL_SCREEN_EXIT_ROOM = '[[data-full-screen]_&]:pr-9';
