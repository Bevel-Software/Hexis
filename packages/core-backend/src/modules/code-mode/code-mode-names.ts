/**
 * Re-export of the code-mode name helpers, which now live in
 * `@bevel-software/platform-mcp-core` so the local MCP server can share them
 * without depending on this package. Kept as a module here because the agent's
 * Mastra tools and the MCP proxy both import it by this path.
 */
export {
  sanitizeIdentifier,
  utcpNameToTsInterfaceName,
  findToolByName,
  AmbiguousToolNameError,
} from '@bevel-software/platform-mcp-core';
