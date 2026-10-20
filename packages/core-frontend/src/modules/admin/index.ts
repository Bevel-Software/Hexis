/**
 * Administration's public surface: the admin context, the settings pages the
 * shell mounts, and the role reads other modules offer from their own
 * screens. Other modules import these from here rather than reaching into
 * admin's files.
 */
export { AdminRolesPage } from './components/AdminRolesPage';
export { DirectoryGroupsPage } from './components/DirectoryGroupsPage';
export { RolesCorruptedBanner } from './components/RolesCorruptedBanner';
export { UserAccountsPage } from './components/UserAccountsPage';
export { pathForGroupMembers } from './components/group-members-path';
export { addMember, fetchRoles } from './services/roles.api';
export { AdminContext, AdminProvider, useAdmin } from './state/admin.context';
