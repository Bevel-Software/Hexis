import type express from 'express';
import { AdminAccessService } from '../modules/admin/admin-access.service.js';
import { createAccountRoutes } from '../modules/auth/account.routes.js';
import type { IAccessControl } from '../modules/access/index.js';
import type { WorkspaceService } from '../modules/workspace/index.js';

/**
 * The deployment admin check and the account admin routes, composed the way
 * the composition root composes them (`core/create-core-services.ts` and
 * `core/create-core-server.ts`). A module's suite that drives those routes
 * end to end takes them from HERE rather than constructing another module's
 * implementation itself: the admin and auth entries hold their contracts,
 * and the classes and routers behind them are the root's to wire — as
 * `real-disk.ts` stands in for the root for the filesystem.
 */
export function realAdminAccess(
  access: IAccessControl,
  workspace: WorkspaceService,
  defaultBranch: string,
  owners: string[],
): AdminAccessService {
  return new AdminAccessService(access, workspace, defaultBranch, owners);
}

export function realAccountRoutes(...args: Parameters<typeof createAccountRoutes>): express.Router {
  return createAccountRoutes(...args);
}
