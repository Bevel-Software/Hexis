/**
 * Skills & Tools' public surface: what other modules may link to or call
 * without reaching into the Library's files.
 */

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
