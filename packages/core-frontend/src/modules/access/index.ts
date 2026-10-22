/**
 * What the access module offers the other modules. A consumer outside the
 * module imports from here, never from the files: they are the module's own
 * layout and free to move. Export what another module needs; nothing more.
 */
export { fetchAdmins, fetchFileAccess, fetchFileAccessBatch, fetchProspectiveAccess, parsePluginPrincipalToken, pluginPrincipalLabel, suggestPrincipals } from './api';
export type { AccessEligible, AccessPrincipalRef, AccessResponse, AdminContact, GrantSources, PathPrincipals, ProspectiveAccess } from './api';
export { useAccessRequests } from './hooks/useAccessRequests';
export type { AccessRequestsState } from './hooks/useAccessRequests';
export { formatEligible, useFileAccess } from './hooks/useFileAccess';
export { offersManageAccess } from './manage-access-affordance';
