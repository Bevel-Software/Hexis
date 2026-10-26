/**
 * What the settings module offers the other modules. A consumer outside the
 * module imports from here, never from the files: they are the module's own
 * layout and free to move. Export what another module needs; nothing more.
 */
export { fetchMarketplaceRegistration } from './services/github-facade.api';
export { isSettingsNavPath, useMenuSections } from './settings-nav-items';
export type { MenuSections } from './settings-nav-items';
