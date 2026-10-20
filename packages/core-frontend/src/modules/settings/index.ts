/**
 * Settings' public surface: the settings layout and pages the shell mounts,
 * the settings navigation, and the marketplace and Claude connection cards
 * other screens show. Other modules import these from here rather than
 * reaching into settings' files.
 */
export { ClaudeConnectionCard } from './components/ClaudeConnectionCard';
export { DeploymentPage } from './components/DeploymentPage';
export { MarketplaceSection } from './components/MarketplaceSection';
export { SettingsLayout } from './components/SettingsLayout';
export { fetchMarketplaceRegistration } from './services/github-facade.api';
export { isSettingsNavPath, type MenuSections, useMenuSections } from './settings-nav-items';
