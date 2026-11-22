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
/** Whether a managed sign-in can be started from here: the one rule the Connect page and the tool page share. */
export { canStartSignIn } from './utils/managed-card-state';
/**
 * The bot the enclosing Secrets or Connect tools page acts for (null: the
 * person) — for a distribution's `connectPanel`, which renders inside that
 * page and must read and write the same identity's secrets.
 */
export { useActingForBot, type ActingFor } from './services/acting-for';
