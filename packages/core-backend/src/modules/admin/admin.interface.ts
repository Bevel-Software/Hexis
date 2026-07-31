/**
 * Contract for the deployment admin check. A user is an admin iff they hold the
 * `Admin` role in the KB's `roles.yaml` — the same source of truth the access
 * model uses for `canWrite('roles.yaml')`. Async because resolving it reads the
 * access model from the default-branch workspace. Kept as an interface so tests
 * can swap a static stub without loading the access tree.
 */
export interface IAdminAccessService {
  isAdmin(email: string | undefined): Promise<boolean>;
}
