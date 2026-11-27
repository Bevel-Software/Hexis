import type { ITreeWalker } from '../shared/fs.contract.js';
import type { WorkspaceService } from '../modules/workspace/index.js';
import { AccessControlService } from '../modules/access/access-control.service.js';

/**
 * The access resolver over a real tree, wired the way the composition root
 * wires it (`core/create-core-services.ts`). A module's suite whose
 * assertions are what the real rules answer after its service ran — who may
 * read, who may write — takes it from HERE rather than constructing another
 * module's implementation itself: the service is on no module entry, by
 * design (a module receives `IAccessControl` by injection), and this fixture
 * stands in for the root, as `real-disk.ts` does for the disk.
 */
export function realAccessControl(workspace: WorkspaceService, kbDirName: string, disk: ITreeWalker): AccessControlService {
  return new AccessControlService(workspace, kbDirName, disk);
}
