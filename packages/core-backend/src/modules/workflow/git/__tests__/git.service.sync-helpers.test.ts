import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { GitService } from '../git.service.js';
import { runGit, gitOut, stubWorkflowHooks, stubWorkspaceService } from './git-test-helpers.js';

/**
 * The two small git reads a remote sync needs: where HEAD is, and which
 * paths a move of HEAD changed. Against a real repository, because the
 * rename parsing depends on git's `-z --name-status` framing.
 */
describe('GitService.headSha / changedPathsBetween', () => {
  let root: string;
  let repo: string;
  let git: GitService;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-git-sync-'));
    const workspaceDir = path.join(root, 'ws');
    repo = path.join(workspaceDir, 'knowledge-base');
    await fs.mkdir(repo, { recursive: true });
    await runGit(repo, ['init', '-b', 'main']);
    await runGit(repo, ['config', 'user.email', 'workspace@bevel.test']);
    await runGit(repo, ['config', 'user.name', 'bevel Workspace']);
    await fs.writeFile(path.join(repo, 'a.md'), 'a\n');
    await fs.writeFile(path.join(repo, 'old name.md'), 'same content that survives a rename\n');
    await runGit(repo, ['add', '.']);
    await runGit(repo, ['commit', '-m', 'one']);
    git = new GitService(stubWorkspaceService({ ws: workspaceDir }), stubWorkflowHooks(), 'knowledge-base');
  });

  afterEach(async () => {
    for (let i = 0; i < 5; i++) {
      try {
        await fs.rm(root, { recursive: true, force: true });
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  });

  it('headSha is the sha of HEAD', async () => {
    expect(await git.headSha('ws')).toBe((await gitOut(repo, ['rev-parse', 'HEAD'])).trim());
  });

  it('changedPathsBetween lists modified, added, deleted and both ends of a rename', async () => {
    const before = await git.headSha('ws');
    await fs.writeFile(path.join(repo, 'a.md'), 'a changed\n');
    await fs.writeFile(path.join(repo, 'b.md'), 'b\n');
    await fs.rename(path.join(repo, 'old name.md'), path.join(repo, 'new name.md'));
    await runGit(repo, ['add', '-A']);
    await runGit(repo, ['commit', '-m', 'two']);
    const after = await git.headSha('ws');

    const paths = await git.changedPathsBetween('ws', before, after);
    expect(paths.sort()).toEqual(['a.md', 'b.md', 'new name.md', 'old name.md'].sort());
    expect(await git.changedPathsBetween('ws', after, after)).toEqual([]);
  });

  it('refuses a sha that is not one', async () => {
    await expect(git.changedPathsBetween('ws', '--output=/tmp/x', 'HEAD')).rejects.toThrow(/Invalid commit sha/);
  });
});
