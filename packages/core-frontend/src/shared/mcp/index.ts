/**
 * Connecting an agent to this workspace over MCP — the endpoint, the snippets
 * each client needs, and the one-click Claude install link.
 *
 * Import from this barrel, the same convention `shared/components` follows.
 */

/*
 * `resetMcpUrlForTests` is deliberately NOT re-exported. It mutates
 * module-global state, and putting it on the public surface invites
 * production code to import something that only makes sense in a test.
 * Tests import it straight from `./connect-snippets`, as `test-setup.ts` does.
 */
export {
  MCP_DISPLAY_NAME,
  MCP_SERVER_KEY,
  canDeepLink,
  chatgptInstallUrl,
  claudeCodeCommand,
  claudeInstallUrl,
  configureMcpUrl,
  connectorName,
  hexisMcpClaudeCommand,
  hexisMcpJsonSnippet,
  jsonConfigSnippet,
  langdockSnippet,
  mcpEndpointUrl,
  workspaceBaseUrl,
} from './connect-snippets';

export { ClaudeInstallLink } from './ClaudeInstallLink';
export { ChatGptInstallLink } from './ChatGptInstallLink';
export { ConnectionInstructions } from './ConnectionInstructions';
export { CopyBlock } from './CopyBlock';
export { useCopyFeedback } from './useCopyFeedback';
