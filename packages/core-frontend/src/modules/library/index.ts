/**
 * Skills & Tools' public surface: what other modules may link to or call
 * without reaching into the Library's files.
 */

/**
 * The Library's mount point. Listed first: other modules read it while they
 * load, and this entry is in an import cycle with them (`routes/library-root.ts`).
 */
export { LIBRARY_ROOT } from './routes/library-root';

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

/**
 * The rest of what the shell and other modules use from the Library, grouped by
 * the file that defines it.
 */
export { NewPluginDialog } from './components/NewPluginDialog';
export { NewSkillPanel } from './components/NewSkillPanel';
export { LibraryRoutes } from './routes/LibraryRoutes';
export {
  isLibraryLocation,
  pathForLibraryFilter,
  pathForPlugin,
  pathForSkill,
  urlForLibraryItem,
} from './routes/library-paths';
export { type LibrarySkillSummary, listSkills } from './services/library.api';
export { listPlugins, type PluginSummary } from './services/plugins.api';
export { useLibrary } from './state/library-data';
export { usePluginsRevision } from './state/plugins-revision';
export { useLibraryToast } from './state/toast.context';
export { COPY_FAILED_TOAST, copyToClipboard } from './utils/clipboard';
export { displayFirstName, PERSONAL_PLUGIN_NAME } from './utils/personal-plugin';
export { pluginLabel, pluginNameForPath } from './utils/plugin-summary';
