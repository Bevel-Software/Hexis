/**
 * Access's public surface: who may read a file and how to ask for it — the
 * access reads, the hooks that hold them, and the dialog and banner that
 * manage them. Other modules import these from here rather than reaching into
 * access's files.
 */
export {
  type AccessEligible,
  type AccessPrincipalRef,
  type AccessResponse,
  type AdminContact,
  fetchAdmins,
  fetchFileAccess,
  fetchFileAccessBatch,
  fetchProspectiveAccess,
  type GrantSources,
  parsePluginPrincipalToken,
  type PathPrincipals,
  pluginPrincipalLabel,
  type ProspectiveAccess,
  suggestPrincipals,
} from './api';
export { AccessRequestsBanner } from './components/AccessRequestsBanner';
export { ManageAccessDialog } from './components/ManageAccessDialog';
export { type AccessRequestsState, useAccessRequests } from './hooks/useAccessRequests';
export { formatEligible, useFileAccess } from './hooks/useFileAccess';
export { offersManageAccess } from './manage-access-affordance';
