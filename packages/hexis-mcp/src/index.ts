/**
 * @bevel-software/hexis-mcp — a Hexis workspace as a local MCP server.
 *
 * The hosted endpoint cannot call a tool that only exists on your machine: a
 * `.tool` marked `remote: false` (an MCP server on localhost, an internal HTTP
 * service) is skipped there and only named by `list_local_tools`. This process
 * closes that gap by being where those tools can actually run, while still
 * serving everything the hosted endpoint serves.
 *
 * It does that by registering the deployment's own MCP endpoint as ONE UTCP
 * manual alongside the local-only ones. So the remote tools are not
 * reimplemented here, and — the part that matters — they still EXECUTE on the
 * server: a `.tool` that reaches Notion or a vendor API resolves its `${VAR}`s
 * in the process holding the client, and for those tools that process remains
 * the deployment's, with its Secrets Vault and its completed OAuth sign-ins.
 * Only the local-only tools run here, on credentials from this process's env.
 *
 * Normally run as a command (`npx @bevel-software/hexis-mcp`); the pieces are
 * exported for embedding it in another process.
 */
export { type HexisMcpConfig, type ResolvedCliConfig, ConfigError, resolveConfig, USAGE } from './config.js';
export { DeploymentError, resolveMcpUrl, fetchAllManuals, fetchLocalOnlyManuals } from './deployment.js';
export {
  OAuthError,
  discoverAuthServer,
  readStoredCredentials,
  writeStoredCredentials,
  oauthStorePath,
  refreshAccessToken,
  authorizeInBrowser,
  openInBrowser,
  exchangeForLocalToken,
  establishOAuthConfig,
  type AuthServerEndpoints,
  type StoredOAuthCredentials,
  type BrowserFlowOptions,
  type BrowserFlowResult,
  type LocalTokenGrant,
  type OAuthModeOptions,
} from './oauth.js';
export { REMOTE_MANUAL_NAME, remoteManualTemplate, localManualTemplates } from './manuals.js';
export { createHexisMcpServer, listedTools, type HexisMcpHandle } from './server.js';
