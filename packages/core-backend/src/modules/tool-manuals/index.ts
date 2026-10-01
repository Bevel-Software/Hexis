export { ToolManualService } from './tool-manuals.service.js';
export { PendingToolsService } from './pending-tools.service.js';
export { registerToolManualsTools } from './tool-manuals.tools.js';
export {
  createToolManualsAgentRoutes,
  createToolManualsBrowserRoutes,
} from './tool-manuals.routes.js';
export {
  EXTERNAL_KB_MANUAL_NAME,
  type IPendingToolService,
  type IToolManualService,
  type PendingTool,
  type ToolManualSummary,
  type ToolManualDetail,
  type ToolCapability,
  type ToolManualType,
} from './tool-manuals.contract.js';
