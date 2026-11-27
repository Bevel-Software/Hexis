/**
 * What the admin module offers the other modules: the contract of the
 * deployment admin check — a person is an admin iff they hold the `Admin`
 * role in the knowledge base's `roles.yaml`. Routes that gate on it take the
 * contract; the implementation is wired by the composition root.
 */
export type { IAdminAccessService, IAdminRoleLookup } from './admin.interface.js';
