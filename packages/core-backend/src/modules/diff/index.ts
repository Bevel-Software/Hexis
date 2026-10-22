/**
 * What the diff module offers the other modules. A consumer outside the
 * module imports from here, never from the files: they are the module's own
 * layout and free to move. Export what another module needs; nothing more.
 */
export type { IDiffService } from './diff.interface.js';
