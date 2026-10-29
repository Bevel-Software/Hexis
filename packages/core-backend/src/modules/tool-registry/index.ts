export {
  declaresWrite,
  type IToolRegistry,
  type JsonSchema,
  type ToolListProvider,
  type ToolManualContext,
  type ToolProvider,
  type UtcpTool,
} from './tool.contract.js';
export { ToolRegistry } from './tool-registry.js';
export { createManualRoutes, type ResolveUserEmail } from './manual.routes.js';
export type { IToolReadOnlyHints, ToolReadOnlyEntry } from './read-only-hints.contract.js';
export {
  TOOL_READ_ONLY_SETTING,
  ToolReadOnlyHints,
  UnknownToolError,
  createToolHintsAgentRoutes,
  createToolHintsRoutes,
} from './read-only-hints.js';
// Reached by other modules; exported here so they stop importing the files.
export { TOOL_DESCRIPTION_CAP, clientVisibleLength } from './description-length.js';
export { GET_AGENT_GUIDE_TOOL, GUIDE_FIRST_SENTENCE, guideFirstDescription, withGuideFirst } from './guide-first.js';
