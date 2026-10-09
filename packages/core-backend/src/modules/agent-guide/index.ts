export {
  AGENT_GUIDE_FILE,
  CORE_SECTION_IDS,
  PLATFORM_GUIDE_SEPARATOR,
  WORKING_WITH_FILES_SECTION_ID,
  agentGuideSections,
  composeAgentGuide,
  coreAgentGuideSections,
  isAgentGuidePath,
  isManagedGuide,
  joinGuideSections,
  withPlatformGuideAppended,
  type AgentGuideContext,
  type AgentGuideHook,
  type AgentGuideReader,
  type AgentGuideSection,
  type AgentGuideSectionsReader,
  type RenderedGuideSection,
} from './agent-guide.js';
export { GET_AGENT_GUIDE_TOOL, registerAgentGuideTool } from './agent-guide.tools.js';
export { GUIDE_FIRST_SENTENCE, withGuideFirst } from '../tool-registry/guide-first.js';
