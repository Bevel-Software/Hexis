import type { IAccessControl } from '../access/access-control.interface.js';
import { type WorkspaceService, workspaceIdForBranch } from '../workspace/workspace.service.js';
import type { IAdminAccessService } from './admin.interface.js';

/**
 * Admin = holder of the `Admin` role in `roles.yaml`. We resolve it through the
 * access model exactly as the rest of the app does — `canWrite('roles.yaml')` is
 * the existing source of truth for Admin-role membership (only admins may write
 * `roles.yaml`). Read from the default-branch workspace so admin status doesn't
 * depend on whichever branch the caller happens to be on.
 *
 * There is no env allow-list (`ADMIN_EMAILS` is gone) — `roles.yaml` is the
 * single source of truth.
 */
export class AdminAccessService implements IAdminAccessService {
  constructor(
    private readonly accessControl: IAccessControl,
    private readonly workspaceService: WorkspaceService,
    /** Branch whose `roles.yaml` defines admins (the authoritative default branch). */
    private readonly branch: string,
  ) {}

  async isAdmin(email: string | undefined): Promise<boolean> {
    if (!email) return false;
    try {
      // Ensure the authoritative clone is on disk, then resolve Admin-role
      // membership via the access model. Any failure (missing/invalid
      // roles.yaml, clone error) resolves to "not admin" — the safe default.
      await this.workspaceService.getOrCreateForBranch(this.branch);
      return await this.accessControl.canWrite(workspaceIdForBranch(this.branch), email, 'roles.yaml');
    } catch (err) {
      // Log so an admin lockout caused by a clone / roles.yaml failure is
      // diagnosable rather than a silent denial.
      console.warn('[admin] isAdmin resolution failed:', err instanceof Error ? err.message : String(err));
      return false;
    }
  }
}
