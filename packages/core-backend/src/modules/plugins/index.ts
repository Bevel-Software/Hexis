export { PluginIndexService, pluginsWorkspaceId } from './plugins.service.js';
export {
  PluginProvisionService,
  PluginProvisionError,
  pluginAccessMd,
  personalAccessMd,
} from './plugin-provision.service.js';
export { JoinRequestsService, type JoinRequest } from './join-requests.service.js';
export { PluginLinkIndex, type LinkMembership, type PluginLinks } from './plugin-links.js';
export { PluginLinksService, PluginLinkError } from './plugin-links.service.js';
export { compileMarketplace, type VirtualTree, type CompileInput, type MarketplaceOptions } from './compile/compile-marketplace.js';
export { MarketplaceCompilerService, type CompileAudience } from './compile/marketplace-compiler.service.js';
export type { PluginSource, DiscoveredPlugin, Discovery } from './discovery/plugin-source.js';
export { KbPluginSource } from './discovery/kb-plugin-source.js';
export { DEFAULT_REGISTRY_PATH } from './discovery/bundle-dialect/bundle.source.js';
export { pendingProposals, type JoinProposal } from './join-proposals.js';
export { createPluginsRoutes } from './plugins.routes.js';
export type {
  IPluginIndexService,
  PluginCatalogEntry,
  PluginMembership,
  PluginSummary,
  ResolvedPrincipals,
  ResolvedReaders,
} from './plugins.contract.js';
