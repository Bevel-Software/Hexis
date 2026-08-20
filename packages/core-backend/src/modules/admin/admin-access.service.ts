import type { IAccessControl } from '../access/access-control.interface.js';
import { type WorkspaceService } from '../workspace/workspace.service.js';
import { workspaceIdForBranch } from '../../shared/workspace-id.js';
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
    private readonly branch: string | (() => string),
    /**
     * Emails treated as admin WITHOUT consulting `roles.yaml` — the env
     * bootstrap admin (`ADMIN_EMAIL`). A fresh deployment's KB may not list
     * that email yet, and the bootstrap credential must be able to administer
     * accounts/roles regardless; membership here tracks the env var, so
     * removing the var removes the privilege.
     */
    private readonly alwaysAdminEmails: string[] = [],
  ) {}

  async isAdmin(email: string | undefined): Promise<boolean> {
    if (!email) return false;
    const normalized = email.trim().toLowerCase();
    if (this.alwaysAdminEmails.includes(normalized)) return true;
    try {
      // Ensure the authoritative clone is on disk, then resolve Admin-role
      // membership via the access model. Any failure (missing/invalid
      // roles.yaml, clone error) resolves to "not admin" — the safe default.
      const branch = typeof this.branch === 'function' ? this.branch() : this.branch;
      await this.workspaceService.getOrCreateForBranch(branch);
      return await this.accessControl.canWrite(workspaceIdForBranch(branch), email, 'roles.yaml');
    } catch (err) {
      // Log so an admin lockout caused by a clone / roles.yaml failure is
      // diagnosable rather than a silent denial.
      console.warn('[admin] isAdmin resolution failed:', err instanceof Error ? err.message : String(err));
      return false;
    }
  }
}
