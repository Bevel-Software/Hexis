/**
 * What the mcp module offers the other modules. A consumer outside the
 * module imports from here, never from the files: they are the module's own
 * layout and free to move. Export what another module needs; nothing more.
 */
export { signAuthRequest } from './oauth/oauth-state.js';
export type { McpAuthRequestState } from './oauth/oauth-state.js';
