/**
 * Onboarding's public surface: the landing and welcome pages, the getting-
 * started column, the invite dialog, and the state behind the setup
 * checklist. Other modules import these from here rather than reaching into
 * onboarding's files.
 */
export { ConnectAgentPill } from './components/ConnectAgentPill';
export { CreatorWelcomePage } from './components/CreatorWelcomePage';
export { GetStartedColumn } from './components/GetStartedColumn';
export { InviteButton } from './components/InviteButton';
export { RootLanding } from './components/RootLanding';
export { StarterPackCard } from './components/StarterPackCard';
export { WelcomePage } from './components/WelcomePage';
export { WELCOME_PATH } from './paths';
export { type InviteDialogController, useInviteDialog } from './state/invite-dialog.context';
export { InviteDialogProvider } from './state/invite-dialog';
export { useOnboarding, useSetupChecklist } from './state/onboarding';
export { useStarterPacks } from './state/starter-packs';
