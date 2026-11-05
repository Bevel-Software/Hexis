/**
 * What the settings module offers the other modules: the deployment settings
 * service as a contract for a route that reads or writes a setting, the
 * parsers of the settings whose stored text another module interprets (the
 * tool read-only overrides), and the shapes of the repository source a git
 * integration configures itself from. The service is wired by the
 * composition root.
 */
export type { DeploymentSettingsService, ResolvedSetting, SettingSource } from './deployment-settings.service.js';
export { parseToolReadOnlyOverrides } from './deployment-settings.service.js';
export { normalizeIssuerUrl } from './oidc-check.js';
export type { GitHubAppRepository, SettingReader } from './repository-source.js';
