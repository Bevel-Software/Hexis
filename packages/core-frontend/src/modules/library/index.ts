/**
 * The Library's public surface for other modules: the routing contract that
 * says which URLs are Skills & Tools pages and which workspace file such a
 * page shows. Other modules import these from here rather than reaching into
 * the Library's files.
 */
export { LIBRARY_ROOT, isLibraryLocation, libraryItemWorkspacePath } from './routes/library-paths';
