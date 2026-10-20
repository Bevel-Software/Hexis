/**
 * The toolbar's public surface: the toolbar itself, the external agent
 * access page, the command menu and its actions, and the Claude registration
 * steps other screens show. Other modules import these from here rather than
 * reaching into the toolbar's files.
 */
export type { CommandAction } from './commands/actions';
export { COMMAND_MENU_SHORTCUT_LABEL, openCommandMenu } from './commands/command-menu';
export { ClaudeRegistrationSteps } from './components/ClaudeRegistrationSteps';
export { ExternalAgentAccessPage } from './components/ExternalAgentAccessPage';
export { Toolbar } from './components/Toolbar';
