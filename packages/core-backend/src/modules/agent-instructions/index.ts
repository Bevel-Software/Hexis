export {
  composeAgentInstructions,
  prefixToolDescription,
  platformInstructions,
  INSTRUCTIONS_CAP,
  PLATFORM_HEADER,
  TOOL_PREFIX_LINE,
  PREAMBLE_CAP,
  TOOL_PREFIX_CAP,
  PREAMBLE_FILE,
  PREFIXED_TOOLS,
  PREAMBLE_TRUNCATION_MARKER,
  type ComposedAgentInstructions,
} from './compose.js';
export {
  SHARED_FILE_RULES_CAP,
  SHARED_RULES_POINTER_MAX,
  SHARED_RULES_SECTION,
  sharedFileRules,
  sharedFileRulesSection,
  sharedRulesPointer,
  type SharedFileRule,
} from './shared-file-rules.js';
export { readAgentPreamble, type AgentPreambleReader, type PreambleWorkspace } from './read-preamble.js';
export { createAgentInstructionsRoutes } from './agent-instructions.routes.js';
