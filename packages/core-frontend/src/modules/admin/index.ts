/**
 * What the admin module offers the other modules. A consumer outside the
 * module imports from here, never from the files: they are the module's own
 * layout and free to move. Export what another module needs; nothing more.
 */
export { addMember, fetchRoles } from './services/roles.api';
export { AdminContext, useAdmin } from './state/admin.context';
