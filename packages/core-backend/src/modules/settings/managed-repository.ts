import fs from 'node:fs/promises';
import path from 'node:path';
import type { IGitRunner } from '../../shared/git.contract.js';

/** The folder the managed repository is kept in, under the root it is given. */
export const MANAGED_REPOSITORY_DIR = 'knowledge-base.git';

/** The branch a managed repository starts on when the deployment names none. */
export const MANAGED_DEFAULT_BRANCH = 'main';

/**
 * The repository a deployment keeps FOR ITSELF, when its admin chose not to
 * bring one: a bare git repository on the deployment's own disk.
 *
 * Nothing else about the deployment changes. Working copies are cloned from
 * it, pushed to it and fetched from it exactly as they are from a
 * repository on a host; it happens to be reached by a path, and to need no
 * credential. An empty one is seeded by the startup phase like any empty
 * remote.
 *
 * WHERE IT LIVES IS THE WHOLE DECISION. It is the only copy of the
 * knowledge base that is not a working copy, so it has to be somewhere that
 * survives the container and that nothing tidies up:
 *
 *  - not under the workspaces root, where the workspace service's orphan
 *    sweep removes every folder that is not a known branch's;
 *  - not in a new folder beside it, which every shipped compose file would
 *    have to grow a volume for, and a deployment started from an older file
 *    would lose on its next redeploy without a word.
 *
 * The composition root puts it under the BACKUPS root: a volume of its own
 * in every compose file that has ever shipped, and one nothing sweeps.
 */
export class ManagedRepository {
  /** The repository's folder: what git is given as the remote. */
  readonly path: string;

  constructor(private readonly root: string) {
    this.path = path.join(root, MANAGED_REPOSITORY_DIR);
  }

  /** Whether the repository is there. A folder that is not a repository does not count. */
  async exists(): Promise<boolean> {
    return fs.access(path.join(this.path, 'HEAD')).then(
      () => true,
      () => false,
    );
  }

  /**
   * Make sure the repository exists, creating it empty when it does not.
   * One that exists is left exactly as it is: this never re-initialises,
   * and never touches a ref.
   */
  async ensure(runner: IGitRunner, initialBranch: string = MANAGED_DEFAULT_BRANCH): Promise<void> {
    if (await this.exists()) return;
    await fs.mkdir(this.root, { recursive: true });
    // A folder that is there without being a repository is somebody's, and
    // initialising over it would mix a repository into their files.
    const entries = await fs.readdir(this.path).catch(() => null);
    if (entries && entries.length > 0) {
      throw new Error(
        `${this.path} exists and is not a git repository. Move it away, or empty it, before choosing a managed repository.`,
      );
    }
    await runner.run(this.root, ['init', '--bare', `--initial-branch=${initialBranch}`, this.path]);
  }
}
