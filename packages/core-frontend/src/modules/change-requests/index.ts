/**
 * What the change-requests module offers the other modules. A consumer outside the
 * module imports from here, never from the files: they are the module's own
 * layout and free to move. Export what another module needs; nothing more.
 */
export { refusalLine, useApplyChangeRequest } from './hooks/useApplyChangeRequest';
export { useCrFileDiffs } from './hooks/useCrFileDiffs';
export { useDefaultBranchFile, useFileOnBranch } from './hooks/useFileOnBranch';
export { listChangeRequestsUnderFolder, listMyChangeRequests, listOpenChangeRequests, readFileOnBranch, removeFolderFromChangeRequests } from './services/change-requests.api';
export { branchSegment, ensureKnowledgeChangeRequest, ensureKnowledgeSuggestionWorkspace, knowledgeSuggestionBranchFor, proposeKnowledgeChange } from './services/propose.api';
export type { KnowledgeSuggestionTarget } from './services/propose.api';
export { changeAuthorName, formatWhen, othersPendingBesides } from './utils/author';
export { conflictResolutionPrompt } from './utils/conflict';
export type { DiffLine } from './utils/diff';
