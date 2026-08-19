import path from 'node:path';
import type { AuthUser, IWorkflowService } from '@bevel-software/platform-shared';
import type { WorkspaceService } from '../workspace/workspace.service.js';
import { workspaceIdForBranch } from '../../shared/workspace-id.js';
import type { AccessControlService } from './access-control.service.js';
import { SYNCED_GROUPS_YAML } from '../access-model/group-files.js';
import type { WorkflowEventBus } from '../workflow/event-bus.js';
import { LockingFilesystem } from '../kb-fs/locking-filesystem.js';
import type { SyncedGroupsWriterDeps } from './synced-groups-writer.js';

/**
 * The git half of the synced-groups materializer: reads/commits
 * `synced-groups.yaml` on the DEFAULT branch through the same lock-aware
 * pipeline every other in-app write uses, attributed to the directory-sync
 * bot. Split from {@link SyncedGroupsWriter} so the writer's render/debounce
 * logic stays testable against plain fakes.
 *
 * All three functions are resilient to an UNCONFIGURED deployment (no branch
 * model yet): reads answer null and writes throw a descriptive error — the
 * writer logs it; a SCIM push arriving before setup completes is a
 * configuration race, not a crash.
 */
export function createSyncedGroupsCommitter(deps: {
  workspaceService: WorkspaceService;
  workflowService: IWorkflowService;
  accessControl: AccessControlService;
  eventBus: WorkflowEventBus;
  kbDirName: string;
  bot: AuthUser;
  /** Thunk — DEFAULT_BRANCH is a live binding that stays empty until setup. */
  defaultBranchOf: () => string;
}): Pick<SyncedGroupsWriterDeps, 'readCurrent' | 'persist' | 'onWritten'> {
  const {
    workspaceService,
    workflowService,
    accessControl,
    eventBus,
    kbDirName,
    bot,
    defaultBranchOf,
  } = deps;

  const repoRelPath = SYNCED_GROUPS_YAML;
  const wsRelPath = `${kbDirName}/${SYNCED_GROUPS_YAML}`;

  return {
    readCurrent: async () => {
      const branch = defaultBranchOf();
      if (!branch) return null;
      await workspaceService.getOrCreateForBranch(branch);
      try {
        return await workspaceService.readFile(
          workspaceIdForBranch(branch),
          path.posix.join(kbDirName, repoRelPath),
        );
      } catch (err) {
        const code = (err as NodeJS.ErrnoException | null)?.code;
        if (code === 'ENOENT' || code === 'ENOTDIR') return null;
        throw err;
      }
    },

    persist: async (content: string) => {
      const branch = defaultBranchOf();
      if (!branch) {
        throw new Error('deployment has no default branch configured yet — cannot materialize synced groups');
      }
      await workspaceService.getOrCreateForBranch(branch);
      const workspaceId = workspaceIdForBranch(branch);
      const basePath = await workspaceService.getWorkspacePath(workspaceId);
      // Lock-aware write: acquires the file's lock, writes, and commits the
      // batch as ONE change with a descriptive summary — same pipeline the
      // roles admin's atomic writes use.
      const fsys = new LockingFilesystem(
        { basePath, contained: true },
        { workflow: workflowService, workspaceId, branch, user: bot },
      );
      await fsys.writeFiles(
        [{ path: wsRelPath, content }],
        'Sync directory groups from the identity provider',
      );
    },

    onWritten: () => {
      const branch = defaultBranchOf();
      if (!branch) return;
      const workspaceId = workspaceIdForBranch(branch);
      // A synced-groups change IS an access change: drop the resolver cache
      // and nudge open clients to re-fetch + re-evaluate, mirroring
      // RolesAdminService.emitWrites.
      accessControl.invalidate(workspaceId);
      eventBus.emit({
        kind: 'file-changed',
        workspaceId,
        branch,
        path: wsRelPath,
        newSha: null,
        byUserId: bot.id,
        byUserName: bot.name,
      });
      eventBus.emit({ kind: 'fs-tree-changed', workspaceId, branch });
    },
  };
}
