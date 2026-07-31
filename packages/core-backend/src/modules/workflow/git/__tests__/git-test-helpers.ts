import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { WorkspaceService } from '../../../workspace/workspace.service.js';
import { WorkflowHooks } from '../../workflow-hooks.js';

/**
 * Helpers shared by the GitService integration suites that drive a real git
 * against temp repos (`git.service.pull.test.ts`,
 * `git.service.postMergePull.test.ts`). Not a test file itself — vitest only
 * picks up `*.test.ts`.
 */

const execFileAsync = promisify(execFile);

/** Run git with a pinned test committer identity, discarding output. */
export async function runGit(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@x.com',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@x.com',
    },
  });
}

/** Run git and return its trimmed stdout. */
export async function gitOut(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.toString().trim();
}

/** An empty hooks registry — no commit-time validation, so pulls/merges never block. */
export function stubWorkflowHooks(): WorkflowHooks {
  return new WorkflowHooks();
}

/** Resolves each workspace id to its directory, like the real service does. */
export function stubWorkspaceService(dirs: Record<string, string>): WorkspaceService {
  return {
    getWorkspacePath: async (id: string) => {
      const dir = dirs[id];
      if (!dir) throw new Error(`unexpected workspace ${id}`);
      return dir;
    },
  } as unknown as WorkspaceService;
}
