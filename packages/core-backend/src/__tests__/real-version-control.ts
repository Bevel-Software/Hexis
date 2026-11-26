import type { KbContext } from '../shared/kb-context.js';
import type { WorkspaceService } from '../modules/workspace/index.js';
import { GitService } from '../modules/version-control/git/git.service.js';
import { VersionControlHooks } from '../modules/version-control/version-control-hooks.js';
import type { IAccessControl } from '../modules/access/index.js';
import type { IChangeReadGate } from '../modules/access-model/index.js';
import { VersionControlEventBus } from '../modules/version-control/index.js';
import { FileLockService } from '../modules/version-control/file-lock.service.js';
import type { PendingCommitsService } from '../modules/version-control/pending-commits.service.js';
import { VersionControlService } from '../modules/version-control/version-control.service.js';
import { makeFakeLockDb, type FakeLockDb } from '../modules/version-control/__tests__/fake-file-lock-db.js';

/**
 * The version-control collaborators, wired the way the composition root wires
 * them (`core/create-core-services.ts`): the git service over a workspace and
 * the lifecycle hooks it consults — where every commit it lands is reported
 * (`onCommitLanded`). A module's suite that commits to a real repository
 * takes them from HERE rather than constructing another module's
 * implementation itself: none of them is on a module entry, by design — they
 * arrive by injection — and this fixture stands in for the root, as
 * `real-disk.ts` does for the disk.
 */
export function realVersionControlHooks(): VersionControlHooks {
  return new VersionControlHooks();
}

export function realGitService(workspace: WorkspaceService, hooks: VersionControlHooks, kb: KbContext): GitService {
  return new GitService(workspace, hooks, kb);
}

/**
 * The lock service the composition root wires, over the in-memory `file_locks`
 * table the version-control suites use, so the contention rules a suite meets
 * are the code that enforces them. `table` seeds rows (a lapsed lock, say).
 */
export function realFileLocks(): { locks: FileLockService; table: FakeLockDb } {
  const table = makeFakeLockDb();
  return { locks: new FileLockService(table.db), table };
}

/**
 * The version-control service with its LOCK half real — the acquire gate,
 * `holdsEditLock`, the release — over `locks`, and the given access answers,
 * read gate and commit queue. Git, change requests and the workspace are not
 * wired: a suite that reaches them fails loudly, and needs the full root.
 */
export function realLockingVersionControl(deps: {
  locks: FileLockService;
  accessControl: IAccessControl;
  pendingCommits: Pick<PendingCommitsService, 'enqueue'>;
  changeGate: IChangeReadGate;
  kb: KbContext;
  events?: VersionControlEventBus;
}): VersionControlService {
  return new VersionControlService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    deps.accessControl,
    deps.locks,
    deps.pendingCommits as PendingCommitsService,
    deps.kb,
    deps.changeGate,
    deps.events ?? new VersionControlEventBus(),
  );
}
