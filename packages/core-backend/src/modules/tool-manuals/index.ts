// The services are types here: the composition root constructs them from
// their files, so a module that imports this entry for a helper or a type
// does not load the implementations.
export type { ToolManualService } from './tool-manuals.service.js';
export type { PendingToolsService } from './pending-tools.service.js';
export { registerToolManualsTools } from './tool-manuals.tools.js';
export {
  createToolManualsAgentRoutes,
  createToolManualsBrowserRoutes,
} from './tool-manuals.routes.js';
export {
  EXTERNAL_KB_MANUAL_NAME,
  type ConnectorScope,
  type IPendingToolService,
  type IToolManualService,
  type PendingTool,
  type ToolManualSummary,
  type ToolManualDetail,
  type ToolCapability,
  type ToolManualType,
} from './tool-manuals.contract.js';
// Reached by other modules; exported here so they stop importing the files.
export { judgeMcpServerEntry } from './mcp-json-discovery.js';
export type { PortableHttpEntry, PortableStdioEntry } from './mcp-json-discovery.js';
export { MAX_CAPABILITIES } from './tool-manuals.contract.js';
export type { ToolHealthCheck, ToolManualDescriptor, ToolProbeTarget, ToolVariable } from './tool-manuals.contract.js';
export { normalizeToolManual } from './tool-manuals.service.js';
