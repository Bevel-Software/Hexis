/**
 * What the toolbar module offers the other modules. A consumer outside the
 * module imports from here, never from the files: they are the module's own
 * layout and free to move. Export what another module needs; nothing more.
 */
export { COMMAND_MENU_SHORTCUT_LABEL, openCommandMenu } from './commands/command-menu';
