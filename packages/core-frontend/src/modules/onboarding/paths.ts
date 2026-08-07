import { LIBRARY_ROOT } from '../library/routes/library-paths';

/**
 * The welcome page lives INSIDE the Library surface (it renders in
 * `LibraryLayout`, so the sidebar — and the pill's selected state — are on
 * screen with it). One constant, three consumers: the route, the pill, the
 * root redirect.
 */
export const WELCOME_PATH = `${LIBRARY_ROOT}/welcome`;
