/**
 * Secrets & connections' public surface: what other modules may mount or call
 * without reaching into this module's files.
 */

/** "Connect your tools", mounted by Skills & Tools at `/skills-and-tools/connect`. */
export { ConnectToolsPage } from './components/ConnectToolsPage';
/** What the page lists, as the server answers it — for a suite that answers at the HTTP seam. */
export type { ConnectPending } from './services/connect.api';
/** A tool's secrets as the catalog carries them. */
export type { ToolSecrets } from './services/tool-secrets.api';
