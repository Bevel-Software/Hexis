export { AgentScopeService, type PluginFoldersPort } from './agent-scope.service.js';
export { resolveConnectionScope, type AgentChoice, type IAgentScopeResolver } from './agent-scope.contract.js';
export {
  ConnectionScope,
  connectionRefusal,
  describeConnection,
  type ConnectionScopeWire,
  type ScopeAgent,
  type ScopeRoots,
} from './connection-scope.js';
export { parseAgentFile, AgentFileError, AGENT_FILE_EXTENSION, type AgentFileDefinition } from './agent-file.js';
