/**
 * Change requests' public surface: the dialog and link that show one, the
 * change boxes and hooks other screens compose, and the reads and proposals
 * that open one. Importing this entry also loads the module's stylesheet
 * (`change-requests.css`), so a screen that draws its diff marks gets their
 * colours. Other modules import these from here rather than reaching into
 * change-requests' files.
 */
import './change-requests.css';
export { ChangeBox } from './components/ChangeBox';
export { ChangeRequestDialog } from './components/ChangeRequestDialog';
export { ChangeRequestLink } from './components/ChangeRequestLink';
export { FileChangeBoxes } from './components/FileChangeBoxes';
export { refusalLine, useApplyChangeRequest } from './hooks/useApplyChangeRequest';
export { useCrFileDiffs } from './hooks/useCrFileDiffs';
export { useDefaultBranchFile, useFileOnBranch } from './hooks/useFileOnBranch';
export {
  listChangeRequestsUnderFolder,
  listMyChangeRequests,
  listOpenChangeRequests,
  readFileOnBranch,
  removeFolderFromChangeRequests,
} from './services/change-requests.api';
export {
  branchSegment,
  ensureKnowledgeChangeRequest,
  ensureKnowledgeSuggestionWorkspace,
  knowledgeSuggestionBranchFor,
  type KnowledgeSuggestionTarget,
  proposeKnowledgeChange,
} from './services/propose.api';
export { changeAuthorName, formatWhen, othersPendingBesides } from './utils/author';
export { conflictResolutionPrompt } from './utils/conflict';
export type { DiffLine } from './utils/diff';
