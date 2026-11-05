// The services are types here: the composition root constructs them from
// their files, so a module that imports this entry for a helper or a type
// does not load the implementations.
export type { SkillService } from './skills.service.js';
export type { PendingSkillsService } from './pending-skills.service.js';
export { registerSkillsTools } from './skills.tools.js';
export { createSkillsRoutes } from './skills.routes.js';
export { AllowedToolsChecker } from './allowed-tools-check.js';
export type { IAllowedToolsChecker, AllowedToolWarning } from './allowed-tools-check.js';
export { createSkillAccessRequestRoutes } from './skill-access-requests.routes.js';
export type {
  ISkillService,
  IPendingSkillService,
  Skill,
  SkillSummary,
  SkillFileContent,
  PendingSkill,
  GetSkillResult,
  GetSkillOptions,
  ListSkillsOptions,
  SkillHistorySource,
  SkillScope,
} from './skills.contract.js';
// Reached by other modules; exported here so they stop importing the files.
export type { PluginMembership } from './skills.contract.js';
