import path from 'node:path';
import { NodeGitRunner } from '../modules/version-control/git/node-git-runner.js';
import type { IGitRunner } from '../shared/git.contract.js';
import type { ITreeWalker } from '../shared/fs.contract.js';
import type { KbContext } from '../shared/kb-context.js';
import { KbRepository, repositoryDirFor } from '../modules/workspace/kb-repository.js';
import type { IKbRepository } from '../modules/workspace/kb-repository.contract.js';
import { WorkspaceService } from '../modules/workspace/workspace.service.js';
import { KbStartupRunner, type KbStartupRunnerOptions } from '../modules/workspace/startup/kb-startup-runner.js';
import { recordTestRepositoryRoot } from './test-repositories.js';

/**
 * The repository a suite's services share when it builds them by hand: one
 * next to the workspaces root (see `repositoryDirFor`), as the composition
 * root would place it there for a deployment with no backups root. Removed
 * once the file's suites are done (see `test-repositories.ts`): a suite's
 * teardown removes its fixture root, not what sits beside it.
 */
export function testKbRepository(
  workspacesRoot: string,
  kbDirName: string,
  kbRepoUrl: string | (() => string),
  gitRunner?: IGitRunner,
): IKbRepository {
  const dir = repositoryDirFor(workspacesRoot, kbDirName);
  recordTestRepositoryRoot(path.dirname(dir));
  return new KbRepository({
    dir,
    kbRepoUrl: typeof kbRepoUrl === 'function' ? kbRepoUrl : () => kbRepoUrl,
    gitRunner: gitRunner ?? new NodeGitRunner(),
  });
}

/**
 * A WorkspaceService as a suite builds it: the constructor's arguments, with
 * the repository — which only the composition root builds in the product —
 * made here when the suite passes none.
 */
export function newWorkspaceService(
  workspacesRoot: string,
  kbRepoUrl: string | (() => string),
  kb: Pick<KbContext, 'kbDirName' | 'defaultBranch'>,
  disk: ITreeWalker,
  gitRunner: IGitRunner = new NodeGitRunner(),
  setAsideRoot?: string,
  aroundSetAside?: (workspaceId: string, move: () => Promise<void>) => Promise<void>,
  repository?: IKbRepository,
): WorkspaceService {
  return new WorkspaceService(
    workspacesRoot,
    kbRepoUrl,
    kb,
    disk,
    gitRunner,
    setAsideRoot,
    aroundSetAside,
    repository ?? testKbRepository(workspacesRoot, kb.kbDirName, kbRepoUrl, gitRunner),
  );
}

/** A KbStartupRunner as a suite builds it — the repository made here when the suite passes none. */
export function newKbStartupRunner(
  opts: Omit<KbStartupRunnerOptions, 'repository'> & { repository?: IKbRepository },
): KbStartupRunner {
  return new KbStartupRunner({
    ...opts,
    repository: opts.repository ?? testKbRepository(opts.workspacesRoot, opts.kbDirName, opts.kbRepoUrl, opts.gitRunner),
  });
}
