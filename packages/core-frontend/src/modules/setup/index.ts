/**
 * Setup's public surface: the first-run gate the shell mounts, its screen,
 * and the setup status other screens read. Other modules import these from
 * here rather than reaching into setup's files.
 */
export { SetupGate } from './components/SetupGate';
export { SetupScreen } from './components/SetupScreen';
export { useSetupStatus } from './hooks/useSetupStatus';
