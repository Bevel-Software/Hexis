/**
 * What the onboarding module offers the other modules. A consumer outside the
 * module imports from here, never from the files: they are the module's own
 * layout and free to move. Export what another module needs; nothing more.
 */
export { WELCOME_PATH } from './paths';
export { useInviteDialog } from './state/invite-dialog.context';
export type { InviteDialogController } from './state/invite-dialog.context';
export { useAgentConnection } from './state/agent-connection';
export type { AgentConnectionState } from './state/agent-connection';
export { useOnboarding, useSetupChecklist } from './state/onboarding';
export { useStarterPacks } from './state/starter-packs';
