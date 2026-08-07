export { GroupIndexService, groupsWorkspaceId } from './groups.service.js';
export {
  GroupProvisionService,
  GroupProvisionError,
  groupAccessMd,
  personalAccessMd,
} from './group-provision.service.js';
export { JoinRequestsService, type JoinRequest } from './join-requests.service.js';
export { pendingProposals, type JoinProposal } from './join-proposals.js';
export { createGroupsRoutes } from './groups.routes.js';
export type {
  IGroupIndexService,
  GroupCatalogEntry,
  GroupSummary,
  ResolvedPrincipals,
  ResolvedReaders,
} from './groups.contract.js';
