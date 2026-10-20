/**
 * Secrets & connections' public surface: what other modules may mount or call
 * without reaching into this module's files.
 */

/** "Connect your tools", mounted by Skills & Tools at `/skills-and-tools/connect`. */
export { ConnectToolsPage } from './components/ConnectToolsPage';

/**
 * The rest of what the shell and other modules use from secrets & connections, grouped by
 * the file that defines it.
 */
export { SecretsPage } from './components/SecretsPage';
export { ToolSecretsPanel } from './components/ToolSecretsPanel';
export { probeWords } from './probe/probe-verdict';
export { useSavedKeyProbe } from './probe/useSavedKeyProbe';
export { startToolOAuth } from './services/connect.api';
export {
  deleteAdminVar,
  listToolSecrets,
  type ProbeVerdict,
  setAdminVar,
  setOAuthClientSecret,
  setUserVar,
  type ToolSecrets,
  type ToolVarStatus,
} from './services/tool-secrets.api';
