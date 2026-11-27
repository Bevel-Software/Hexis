import type { AuthUser, IVersionControlService } from '@bevel-software/platform-shared';
import type { ICreatorAccess } from '../modules/access-model/index.js';
import { LockingFilesystem } from '../modules/kb-fs/index.js';
import type { ArchiveLandingFor } from '../modules/workspace/workspace.service.js';

/**
 * The landing the app's unzip route is handed, made the way the composition
 * root makes it (`core/create-core-server.ts`): the person's own lock-aware
 * filesystem on the workspace. A route suite that extracts an archive takes it
 * from HERE rather than constructing it itself, as `real-disk.ts` stands in
 * for the root's disk.
 */
export function archiveLandingFor(deps: {
  workspaceService: { getWorkspacePath(workspaceId: string): Promise<string> };
  versionControl: IVersionControlService;
  kbDirName: string;
  creatorAccess?: ICreatorAccess;
}): ArchiveLandingFor {
  return async (workspaceId: string, branch: string, user: AuthUser) =>
    new LockingFilesystem(
      { basePath: await deps.workspaceService.getWorkspacePath(workspaceId), contained: true },
      {
        versionControl: deps.versionControl,
        workspaceId,
        branch,
        user,
        kbDirName: deps.kbDirName,
        creatorAccess: deps.creatorAccess,
      },
    );
}
