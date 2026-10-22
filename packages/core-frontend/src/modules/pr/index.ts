/**
 * The pr module's public surface: the change-request operations other modules
 * call. Composed from the service files here, so a caller depends on the
 * module and not on which file happens to hold a verb.
 */
export { fetchPrDetail } from './services/pr-detail.api';
export { openChangeRequest } from './services/pr-open.api';
export { updateChangeRequest } from './services/pr-edit.api';
export { approvePrFile, revertPrFile, unapprovePrFile } from './services/pr-approvals.api';
export { deleteChangeRequest } from './services/pr-cancel.api';
export { refreshChangeRequestFromTarget } from './services/pr-merge.api';
