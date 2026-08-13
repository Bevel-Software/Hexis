/**
 * Connecting an agent to this workspace over MCP — the endpoint, the snippets
 * each client needs, and the one-click Claude install link.
 *
 * Import from this barrel, the same convention `shared/components` follows.
 */

export {
  canDeepLink,
  claudeCodeCommand,
  claudeInstallUrl,
  configureMcpUrl,
  connectorName,
  jsonConfigSnippet,
  langdockSnippet,
  mcpEndpointUrl,
  resetMcpUrlForTests,
} from './connect-snippets';

export { ClaudeInstallLink } from './ClaudeInstallLink';
export { ConnectionInstructions } from './ConnectionInstructions';
export { CopyBlock } from './CopyBlock';
export { useCopyFeedback } from './useCopyFeedback';
