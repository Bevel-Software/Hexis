/**
 * What the access module offers the other modules: the contract of the access
 * service — who may read, write and own what. The implementation is wired by
 * the composition root.
 */
export type { IAccessControl } from './access-control.interface.js';
// Reached by other modules; exported here so they stop importing the files.
export type { AccessDecisionSource, AccessTargetKind } from './access-control.interface.js';
export { accessMdPathForFolder, fileCarriesAccessRules, governingFolderOf } from './access-mutation.service.js';
export type { AccessMutationService, IAccessMutation, TargetKind } from './access-mutation.service.js';
export { folderTarget, rulesFileFor } from './access-requests.contract.js';
export type { AccessRequestTarget, IAccessRequestLifecycle } from './access-requests.contract.js';
export type { AccessRequestsService, IAccessRequests } from './access-requests.service.js';
export { accessRoster, holderChanges, resolveAccessView } from './access-view.js';
export type { HolderChange } from './access-view.js';
export { sendError } from './admin-route-helpers.js';
export { DIRECTORY_SYNC_BOT_EMAIL } from './directory-sync-bot.js';
export type { UserAccessRemovalService } from './user-access-removal.service.js';
