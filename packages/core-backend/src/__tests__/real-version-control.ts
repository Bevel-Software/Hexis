import type { KbContext } from '../shared/kb-context.js';
import type { WorkspaceService } from '../modules/workspace/index.js';
import { GitService } from '../modules/version-control/git/git.service.js';
import { VersionControlHooks } from '../modules/version-control/version-control-hooks.js';
import { FileChangeNotifier } from '../modules/kb-fs/file-change-notifier.js';

/**
 * The version-control collaborators, wired the way the composition root wires
 * them (`core/create-core-services.ts`): the git service over a workspace,
 * the lifecycle hooks it consults, and the file-change notifier a landed
 * commit is announced to. A module's suite that commits to a real repository
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

export function realFileChangeNotifier(): FileChangeNotifier {
  return new FileChangeNotifier();
}
