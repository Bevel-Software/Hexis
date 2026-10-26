/**
 * Secrets & connections' public surface: what other modules may mount or call
 * without reaching into this module's files.
 */

/** "Connect your tools", mounted by Skills & Tools at `/skills-and-tools/connect`. */
export { ConnectToolsPage } from './components/ConnectToolsPage';
// Reached by other modules; exported here so they stop importing the files.
export { probeWords } from './probe/probe-verdict';
export { useSavedKeyProbe } from './probe/useSavedKeyProbe';
export { startToolOAuth } from './services/connect.api';
export { deleteAdminVar, listToolSecrets, setAdminVar, setOAuthClientSecret, setUserVar } from './services/tool-secrets.api';
export type { ProbeVerdict, ToolSecrets, ToolVarStatus } from './services/tool-secrets.api';
