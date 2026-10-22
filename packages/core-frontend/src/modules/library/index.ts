/**
 * Skills & Tools' public surface: what other modules may link to or call
 * without reaching into the Library's files.
 */

/**
 * The routing contract that says which URLs are Skills & Tools pages, which
 * workspace file such a page shows, and whether a delete took that item.
 */
export {
  LIBRARY_ROOT,
  deleteTookLibraryItem,
  isLibraryLocation,
  libraryItemWorkspacePath,
} from './routes/library-paths';
/** Where "Connect your tools" lives; every in-app link to it uses this. */
export { CONNECT_TOOLS_PATH } from './routes/library-paths';
/**
 * A tool's page, by slug — where a tool sign-in started from a tool page
 * returns to. The server accepts any same-origin path as a return target
 * (`isSafeReturnPath`); this is the one the pages that start a sign-in hand
 * it, so the person lands back on the tool they were looking at.
 */
export { pathForTool } from './routes/library-paths';
/** A tool's mark, as the gallery draws it, for any surface that lists tools. */
export { ToolLogo, type ToolLogoProps } from './components/ToolLogo';
/** The outcome a tool sign-in carries back in the fragment, read once on arrival. */
export { readOAuthFragment, type OAuthFragmentOutcome } from './utils/oauth-fragment';
// Reached by other modules; exported here so they stop importing the files.
export { pathForLibraryFilter, pathForPlugin, pathForSkill, urlForLibraryItem } from './routes/library-paths';
export { listSkills } from './services/library.api';
export type { LibrarySkillSummary } from './services/library.api';
export { listPlugins } from './services/plugins.api';
export type { PluginSummary } from './services/plugins.api';
export { useLibrary } from './state/library-data';
export { usePluginsRevision } from './state/plugins-revision';
export { useLibraryToast } from './state/toast.context';
export { COPY_FAILED_TOAST, copyToClipboard } from './utils/clipboard';
export { PERSONAL_PLUGIN_NAME, displayFirstName } from './utils/personal-plugin';
export { pluginLabel, pluginNameForPath } from './utils/plugin-summary';
