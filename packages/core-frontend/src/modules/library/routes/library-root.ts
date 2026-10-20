/**
 * The Library's mount point inside the shell (`CORE_APPS` `skills-tools`).
 *
 * Alone in a file that imports nothing, because other modules build their
 * own paths from it while they load (`WELCOME_PATH`), and reach it through
 * the Library's index, which sits in an import cycle with them: a file with
 * no imports is evaluated the moment it is first reached, so the value is
 * there whichever file the app happens to load first.
 */
export const LIBRARY_ROOT = '/skills-and-tools';
